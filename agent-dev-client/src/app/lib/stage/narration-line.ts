import type { IntlShape, MessageDescriptor } from 'react-intl';
import { messages } from '../localization/messages.ts';

type ToolNarrationMessageKey =
  | 'screenReady'
  | 'savingDetails'
  | 'passingAlong'
  | 'lookingUp'
  | 'checkingNotes';

export type NarrationMessageKey =
  | 'thinking'
  | ToolNarrationMessageKey
  | 'researchingInitial'
  | 'researching';

export type NarrationLine =
  | {
      kind: 'message';
      message: NarrationMessageKey;
      values?: Record<string, string | number>;
    }
  | { kind: 'authored'; text: string };

const NARRATION_MESSAGES: Record<NarrationMessageKey, MessageDescriptor> = {
  thinking: messages.thinking,
  screenReady: messages.narrationScreenReady,
  savingDetails: messages.narrationSavingDetails,
  passingAlong: messages.narrationPassingAlong,
  lookingUp: messages.narrationLookingUp,
  checkingNotes: messages.narrationCheckingNotes,
  researchingInitial: messages.narrationResearchingInitial,
  researching: messages.narrationResearching,
};

const TOOL_NARRATIONS: ReadonlyArray<{
  match: (toolName: string) => boolean;
  message: ToolNarrationMessageKey;
}> = [
  { match: (name) => name.startsWith('Render'), message: 'screenReady' },
  { match: (name) => /record|log/i.test(name), message: 'savingDetails' },
  { match: (name) => /email|notif|gmail/i.test(name), message: 'passingAlong' },
  { match: (name) => /search|research|firecrawl|scrape/i.test(name), message: 'lookingUp' },
  { match: (name) => /file|storage|read|grep/i.test(name), message: 'checkingNotes' },
];

export function narrationMessageForTool(toolName: string): ToolNarrationMessageKey | undefined {
  return TOOL_NARRATIONS.find((entry) => entry.match(toolName))?.message;
}

export function messageNarration(
  message: NarrationMessageKey,
  values?: Record<string, string | number>,
): NarrationLine {
  return values ? { kind: 'message', message, values } : { kind: 'message', message };
}

export function authoredNarration(text: string): NarrationLine {
  return { kind: 'authored', text };
}

export function formatNarrationLine(line: NarrationLine | null, intl: IntlShape): string {
  if (!line) {
    return '';
  }
  if (line.kind === 'authored') {
    return line.text;
  }
  return intl.formatMessage(NARRATION_MESSAGES[line.message], line.values);
}
