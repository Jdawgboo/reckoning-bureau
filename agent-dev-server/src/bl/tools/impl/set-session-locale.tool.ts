import { z } from 'zod';
import { ToolModel, type ToolExecuteResult } from '../../agent/agent-library.ts';
import type { StableUiLocalizationStatus } from '../../../ws/agent-session.ts';
import type { SessionLocaleRuntime } from '../../messaging/session-locale-runtime.ts';

export const SetSessionLocaleSchema = z
  .object({
    locale: z
      .string()
      .min(1)
      .max(128)
      .refine(isCanonicalLocale, 'locale must be one canonical BCP-47 language tag'),
    evidence: z
      .enum(['explicit', 'conversation'])
      .describe(
        'Use explicit only when the visitor directly asks for a language. Use conversation only ' +
          "when the visitor's complete utterance is clearly in another language and no explicit " +
          'language preference is locked. An unambiguous one-word greeting counts; length alone ' +
          'does not weaken clear evidence. Never infer a ' +
          'switch from a proper noun, city, address, code, URL, ambiguous shared token such as ' +
          '“OK”, or a mixed-language fragment.',
      ),
  })
  .strict();

type SetSessionLocaleInput = z.infer<typeof SetSessionLocaleSchema>;

export class SetSessionLocaleTool extends ToolModel<SetSessionLocaleInput> {
  readonly #runtime: SessionLocaleRuntime;

  constructor(runtime: SessionLocaleRuntime) {
    super({
      name: 'SetSessionLocale',
      description:
        'Commit the language for new response prose and dynamic screen content in this ' +
        'conversation. Call for a direct language request or a complete utterance clearly in ' +
        'another language when no explicit preference is locked. An unambiguous one-word greeting ' +
        'counts. Only a later direct request can replace an explicit preference. Do not call for proper nouns, ' +
        'places, addresses, code, links, ambiguous shared tokens, or mixed-language fragments. ' +
        'This proposes locale intent; stable labels switch separately only after the browser ' +
        'installs and acknowledges a complete bundle.',
      parametersSchema: SetSessionLocaleSchema,
      toolType: 'function',
      isStrict: true,
      isStreaming: false,
      skipOffload: true,
    });
    this.#runtime = runtime;
  }

  async execute(input: SetSessionLocaleInput): Promise<ToolExecuteResult> {
    const committed = await this.#runtime.propose(input.locale, input.evidence);
    const stableUi = this.#runtime.stableUi(committed);
    return {
      output: JSON.stringify({
        committed: {
          messageLocale: committed.messageLocale,
          formatLocale: committed.formatLocale,
          source: committed.source,
          revision: committed.revision,
        },
        stableUi,
        instruction: stableUiInstruction(stableUi),
      }),
    };
  }
}

function isCanonicalLocale(value: string): boolean {
  try {
    const locales = Intl.getCanonicalLocales(value.trim());
    return locales.length === 1 && locales[0] === value;
  } catch {
    return false;
  }
}

function stableUiInstruction(status: StableUiLocalizationStatus): string {
  if (status.status === 'active') {
    return 'The complete stable UI bundle is acknowledged as active on every attached browser.';
  }
  if (status.status === 'source-fallback') {
    return 'Stable UI remains in its prior complete language because localization fell back.';
  }
  if (status.status === 'no-browser') {
    return 'No browser is attached, so there is no stable UI activation to claim.';
  }
  return 'Stable UI activation is pending; do not claim that buttons, labels, or menus changed.';
}
