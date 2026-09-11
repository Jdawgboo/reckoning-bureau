import { isRecord } from '../util/type-guards.ts';

/** Non-UI tools whose result must reach a store instead of rendering. */
export const VOICE_TOOL_NAME = 'playVoiceAssistance';
export const MEMORY_BANK_TOOL_NAME = 'persistToMemoryBank';

export type SignalToolUpdate =
  | { kind: 'voice'; text: string }
  | { kind: 'memory'; summary: string };

/** Content channel a signal tool's result can arrive on. */
export type SignalToolChannel = 'tool' | 'component';

interface SignalToolRegistryEntry {
  readonly name: string;
  /** The content channel this tool's result is EXPECTED to arrive on. */
  readonly channel: SignalToolChannel;
  /** The payload field carrying this tool's value on either channel. */
  readonly field: string;
  readonly kind: SignalToolUpdate['kind'];
}

/**
 * Single source of truth for every signal tool: its name, the content
 * channel its result is expected to arrive on, and the payload field that
 * carries its value. Both current signal tools have no `getComponentName()`
 * override, so the agent kernel emits their result on `ContentType.Tool` —
 * that is the regression class this registry guards against: a refactor
 * silently rerouting the client handler to `ContentType.Component` on the
 * false premise that execute()-API tools emit `ComponentContent` (exactly
 * what killed the memory bank for 6 months, see `resolveSignalToolUpdate`).
 */
const SIGNAL_TOOL_REGISTRY: readonly SignalToolRegistryEntry[] = [
  { name: VOICE_TOOL_NAME, channel: 'tool', field: 'text', kind: 'voice' },
  { name: MEMORY_BANK_TOOL_NAME, channel: 'tool', field: 'summary', kind: 'memory' },
];

function findSignalToolEntry(toolName: string | undefined): SignalToolRegistryEntry | undefined {
  return SIGNAL_TOOL_REGISTRY.find((entry) => entry.name === toolName);
}

/**
 * Resolves the update carried by a "signal" tool (`persistToMemoryBank`,
 * `playVoiceAssistance`) from whichever content channel it arrived on.
 * Neither tool overrides `getComponentName()`, so the agent kernel emits
 * their result on the `ContentType.Tool` channel (`content.content` holds
 * the tool's `uiProps`) — but a tool that does declare a component would
 * carry the same payload shape in `ContentType.Component`'s `props`, so this
 * accepts either as `payload`. Returns `null` for any other tool name, or
 * when the matching tool's expected field is missing.
 *
 * `arrivedOn` is the content channel the caller actually observed the tool
 * on. When it disagrees with the tool's registered channel, this is the
 * exact failure mode that silently killed the memory bank for 6 months — so
 * it logs a loud `console.warn` naming the tool and both channels, then
 * still extracts the payload best-effort from whichever shape arrived. A
 * future reroute degrades to "works + screams" instead of "silently dead".
 */
export function resolveSignalToolUpdate(
  toolName: string | undefined,
  payload: unknown,
  arrivedOn: SignalToolChannel,
): SignalToolUpdate | null {
  const entry = findSignalToolEntry(toolName);
  if (!entry) {
    return null;
  }
  if (entry.channel !== arrivedOn) {
    console.warn(
      `[signal-tool] ${entry.name} arrived as ${channelLabel(arrivedOn)} but is registered as ${entry.channel}-channel — handler may be misrouted (see signal-tool-payload.ts)`,
    );
  }
  const value = stringField(payload, entry.field);
  if (!value) {
    return null;
  }
  return entry.kind === 'voice'
    ? { kind: 'voice', text: value }
    : { kind: 'memory', summary: value };
}

function channelLabel(channel: SignalToolChannel): string {
  return channel === 'component' ? 'Component' : 'Tool';
}

function stringField(payload: unknown, key: string): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}
