/**
 * Mini-framework for channel integrations.
 *
 * Two building blocks every channel needs:
 *
 *   `withTypingIndicator` — wraps any async work in a repeating typing signal.
 *   `handleChannelStream` — consumes an agent run stream and delivers text +
 *     components to the channel through a thin adapter interface.
 *
 * Pattern:
 *
 * ```ts
 * client.on(Events.MessageCreate, async (m) => {
 *   // ... gate, attachments, session ...
 *   await withTypingIndicator(
 *     async () => {
 *       const result = await messaging.sendMessage({ ... });
 *       await handleChannelStream(result.stream, {
 *         renderers: myRenderers,
 *         renderOptions: { markdown: true, streaming: 'progress' },
 *         sendText:        (text)         => channel.send(text),
 *         sendPlaceholder: (label)        => channel.send(label),
 *         sendContent:     (native)       => channel.send({ embeds: [native] }),
 *         editMessage:     (handle, body) => handle.edit(body),
 *       });
 *     },
 *     () => channel.sendTyping().catch(() => {}),
 *     TYPING_INTERVAL_MS,
 *   );
 * });
 * ```
 */

import {
  ContentType,
  type AgentContent,
  type ComponentContent,
  type TextContent,
} from '../types/content.ts';
import { render, shouldRender, type RendererMap, type RenderOptions } from './renderer.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Opaque reference to a message already posted to the channel.
 * The framework passes it back to `editMessage`; the adapter knows the
 * platform-specific type.
 */
export type MessageHandle = unknown;

export interface ChannelStreamWording {
  pendingComponent: string;
  emptyOutput: string;
}

/**
 * Platform callbacks for `handleChannelStream`.
 *
 * The adapter owns the wire format (Discord embeds, Telegram HTML, Slack
 * blocks…) and character limits. The framework owns the state machine (text
 * buffer, placeholder map, rate-limit filtering via `shouldRender`).
 *
 * @template TRendered  Channel's native render output type. For channels that
 *   only emit text, use `never` and leave `sendContent` / `editMessage` as
 *   no-ops — the framework never calls them if `render()` always returns a
 *   string.
 */
export interface ChannelStreamAdapter<TRendered> {
  /**
   * Renderer map keyed by `componentName` (must equal the server-side
   * componentName the tool emits exactly — typos silently fall back to text).
   * Pass `{}` for text-only channels.
   */
  renderers: RendererMap<TRendered>;
  /**
   * Channel capabilities: `markdown` flag + `streaming` mode.
   * Typical values:
   *   `{ markdown: true, streaming: 'progress' }` — Discord, Telegram, Slack
   *   `{ streaming: 'final' }`                    — email, SMS, eval, schedule
   */
  renderOptions: RenderOptions;
  /**
   * Send a text reply. The adapter handles chunking for platform character
   * limits. Not called for empty text.
   */
  sendText(text: string): Promise<void>;
  /**
   * Post a placeholder while a component is executing (loading spinner, etc.).
   * Returns an opaque handle that `editMessage` receives later.
   * Return `null` to skip placeholder tracking (terminal state posts fresh).
   */
  sendPlaceholder(label: string): Promise<MessageHandle | null>;
  /**
   * Post a native-rendered component fresh — no placeholder involved.
   * Called when:
   *  - `streaming: 'final'` mode (no placeholders at all), OR
   *  - terminal state arrived but the placeholder was lost (rare disconnect).
   */
  sendContent(content: TRendered): Promise<void>;
  /**
   * Edit a previously-posted placeholder to its final state.
   * `content` is either the channel-native render result or a fallback string.
   * Do not throw — wrap platform errors internally.
   */
  editMessage(handle: MessageHandle, content: string | TRendered): Promise<void>;
  /** Host-supplied stable wording in the session's committed language. */
  wording: ChannelStreamWording;
}

// ─── withTypingIndicator ─────────────────────────────────────────────────────

/**
 * Run `fn` inside a repeating typing indicator.
 *
 * Fires `sendTyping` immediately, then every `intervalMs` ms.
 * Always clears the timer in `finally` — even if `fn` throws.
 *
 * Wrap the entire per-message flow (not just the stream loop) so the typing
 * indicator stays active during attachment download and the LLM call.
 */
export async function withTypingIndicator<T>(
  fn: () => Promise<T>,
  sendTyping: () => void,
  intervalMs = 4000,
): Promise<T> {
  try {
    sendTyping();
  } catch {
    /* non-fatal */
  }
  const timer = setInterval(() => {
    try {
      sendTyping();
    } catch {
      /* non-fatal */
    }
  }, intervalMs);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

// ─── handleChannelStream ─────────────────────────────────────────────────────

/**
 * Consume an agent run stream and deliver it to the channel.
 *
 * **Text**: accumulates in a buffer. Flushed via `adapter.sendText` before
 * posting a component placeholder (preserves chat order) and at end-of-stream.
 *
 * **Components** (placeholder-edit pattern):
 *   - `input-available` → flush text buffer, post placeholder.
 *   - `output-available` / `output-error` → edit placeholder with
 *     `render(renderers, content, renderOptions)`. Falls back to text when the
 *     renderer map has no entry for the component.
 *   - All other states filtered by `shouldRender(state, renderOptions.streaming)`.
 *
 * Resolves after the stream is exhausted and all pending sends complete.
 */
export async function handleChannelStream<TRendered>(
  stream: AsyncIterable<AgentContent>,
  adapter: ChannelStreamAdapter<TRendered>,
): Promise<void> {
  const pendingText = adapter.wording.pendingComponent;
  const emptyFallback = adapter.wording.emptyOutput;

  let textBuf = '';
  const placeholders = new Map<string, MessageHandle>();

  const flushText = async () => {
    const text = textBuf.trim();
    textBuf = '';
    if (text) {
      await adapter.sendText(text);
    }
  };

  for await (const content of stream) {
    // ── Text content ──────────────────────────────────────────────────────
    if (content.type === ContentType.Text) {
      const t = content as TextContent;
      // Skip reasoning tokens and user-role echoes (role is 'user' | undefined on TextContent)
      if (t.isReasoning || t.role === 'user') {
        continue;
      }
      textBuf += t.content ?? '';
      continue;
    }

    // ── Component content ─────────────────────────────────────────────────
    if (content.type !== ContentType.Component) {
      continue;
    }
    const cc = content as ComponentContent;
    const state = cc.streaming?.state;

    if (!shouldRender(state, adapter.renderOptions.streaming)) {
      continue;
    }

    const toolCallId = cc.streaming?.toolCallId;
    if (!toolCallId) {
      continue;
    }

    // input-available → flush text, post placeholder
    if (state === 'input-available') {
      await flushText();
      if (!placeholders.has(toolCallId)) {
        const handle = await adapter.sendPlaceholder(pendingText);
        if (handle != null) {
          placeholders.set(toolCallId, handle);
        }
      }
      continue;
    }

    // Terminal state → render + edit (or post fresh when placeholder was missed)
    const rendered = render(adapter.renderers, cc, adapter.renderOptions);
    const finalContent = rendered === '' ? emptyFallback : rendered;
    const handle = placeholders.get(toolCallId);
    placeholders.delete(toolCallId);

    if (handle == null) {
      // No placeholder: final mode or missed input-available
      if (typeof finalContent === 'string') {
        await adapter.sendText(finalContent);
      } else {
        await adapter.sendContent(finalContent);
      }
      continue;
    }

    await adapter.editMessage(handle, finalContent);
  }

  await flushText();
}
