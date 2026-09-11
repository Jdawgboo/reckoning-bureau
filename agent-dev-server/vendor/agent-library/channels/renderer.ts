import type { ComponentContent, ToolPartState } from '../types/content.ts';

/**
 * Channel-specific renderer for a single component.
 *
 * Takes the props of a `ComponentContent` and produces output in the
 * channel's native format (React element, Discord embed, Slack block, etc.).
 *
 * @template TOutput The channel's output format. For web use ReactNode (or your
 *   FC<P> type); for Discord use the embed object; for Slack use Block Kit; etc.
 */
export type ChannelRenderer<TOutput> = (props: Record<string, unknown>) => TOutput;

/**
 * Map of `componentName` → renderer for one channel.
 *
 * @example
 * ```ts
 * // Web (browser)
 * export const webRenderers: RendererMap<ReactElement> = {
 *   Image: (props) => <ImageComponent {...props} />,
 *   Table: (props) => <TableComponent {...props} />,
 * };
 *
 * // Discord (Node)
 * export const discordRenderers: RendererMap<DiscordEmbed> = {
 *   Image: (props) => ({ type: 'image', url: props.src }),
 * };
 * ```
 */
export type RendererMap<TOutput> = Record<string, ChannelRenderer<TOutput>>;

/**
 * Channel consumption mode. Declares which streaming states a channel handler
 * should forward to `render()`. Does not change the renderer signature — the
 * filter happens at the channel handler before `render()` is called.
 *
 *  - `'token'`    — every state (`input-streaming` + `input-available` +
 *                   `output-pending` + `output-available` + `output-error`).
 *                   Web only; non-web channels burn rate limits at this rate.
 *  - `'progress'` — `input-available` (placeholder trigger) + terminal states
 *                   (`output-available`, `output-error`). Discord, Slack.
 *  - `'final'`    — terminal only. Email, SMS, voice transcript, eval, schedule.
 *
 * Default for new channels: `'final'` (safe — never blows a rate limit).
 */
export type StreamingMode = 'token' | 'progress' | 'final';

/**
 * Channel capabilities, used by `render()` to pick the right fallback layer
 * and by channel handlers to filter incoming streaming events.
 */
export interface RenderOptions {
  /**
   * Whether the channel renders Markdown natively. When true, `render()`
   * prefers `content.fallbackMarkdown` over `content.fallbackText` if no
   * native renderer is found. Defaults to false (plain text).
   *
   * Web (React Markdown), Discord, Slack, email → true.
   * SMS, voice transcripts, plain logs, eval → false.
   */
  markdown?: boolean;
  /**
   * Channel consumption mode. Used by channel handlers (not by `render()`)
   * to decide which streaming states to forward. See {@link StreamingMode}.
   * Defaults to `'final'` when omitted.
   */
  streaming?: StreamingMode;
}

/**
 * Pick a renderer for a component and invoke it. Falls back to text when the
 * channel has no native renderer for that component:
 *  - markdown-aware channel (`options.markdown: true`): prefers
 *    `fallbackMarkdown`, then `fallbackText`.
 *  - plain channel (default): just `fallbackText`.
 *
 * Returns the channel's native output type or a fallback string.
 *
 * @example
 * ```ts
 * const out = render(discordRenderers, content, { markdown: true });
 * if (typeof out === 'string') {
 *   await discord.send({ content: out });    // markdown source, Discord renders it
 * } else {
 *   await discord.send({ embeds: [out] });   // native renderer hit
 * }
 * ```
 */
export function render<TOutput>(
  map: RendererMap<TOutput>,
  content: ComponentContent,
  options?: RenderOptions,
): TOutput | string {
  const renderer = map[content.componentName];
  if (renderer) {
    return renderer(content.props);
  }
  if (options?.markdown && content.fallbackMarkdown) {
    return content.fallbackMarkdown;
  }
  return content.fallbackText ?? '';
}

/**
 * True if a channel with consumption mode `mode` should forward this state to
 * its renderer/transport. Use this at the top of a channel handler so the
 * channel-author doesn't reimplement the matrix per channel.
 *
 * @example
 * ```ts
 * function onAgentContent(content: ComponentContent) {
 *   if (!shouldRender(content.streaming?.state, discordRenderOptions.streaming)) {
 *     return;
 *   }
 *   const out = render(discordRenderers, content, discordRenderOptions);
 *   // …post or edit Discord message
 * }
 * ```
 */
export function shouldRender(
  state: ToolPartState | undefined,
  mode: StreamingMode = 'final',
): boolean {
  if (!state) {
    return false;
  }
  if (mode === 'token') {
    return true;
  }
  const isTerminal = state === 'output-available' || state === 'output-error';
  if (mode === 'progress') {
    return state === 'input-available' || isTerminal;
  }
  return isTerminal;
}
