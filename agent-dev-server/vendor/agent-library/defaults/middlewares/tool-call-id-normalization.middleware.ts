import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import type { LanguageModelMiddleware } from 'ai';
import type {
  KernelModelMiddleware,
  KernelModelMiddlewareContext,
} from '../../kernel/middlewares/types.ts';
import { generateShortId } from '../../types/id.ts';
import { getAgentLogger } from '../../types/logger.ts';

const logger = getAgentLogger();

export const TOOL_CALL_ID_MARKER = '_ap_';

const TAGGED_ID_SUFFIX = /_ap_[a-z0-9]{8}$/;

/** Providers verified to mint per-response sequential ids that recycle (AGE-378 V1/V11). */
const TAGGED_PROVIDER_PREFIXES = ['bedrock-mantle.'];

export function isTaggedToolCallId(id: string): boolean {
  return TAGGED_ID_SUFFIX.test(id);
}

export function stripToolCallId(id: string): string {
  return id.replace(TAGGED_ID_SUFFIX, '');
}

function shouldTagProvider(provider: string | undefined): boolean {
  return provider != null && TAGGED_PROVIDER_PREFIXES.some((p) => provider.startsWith(p));
}

function stripPart<T>(part: T): T {
  if (typeof part !== 'object' || part === null || !('type' in part) || !('toolCallId' in part)) {
    return part;
  }
  if (part.type !== 'tool-call' && part.type !== 'tool-result') {
    return part;
  }
  if (typeof part.toolCallId !== 'string' || !isTaggedToolCallId(part.toolCallId)) {
    return part;
  }
  return { ...part, toolCallId: stripToolCallId(part.toolCallId) };
}

function stripPromptIds(prompt: LanguageModelV3Prompt): LanguageModelV3Prompt {
  let changed = false;
  const next = prompt.map((message) => {
    if (typeof message.content === 'string' || !Array.isArray(message.content)) {
      return message;
    }
    let messageChanged = false;
    const content = message.content.map((part) => {
      const stripped = stripPart(part);
      if (stripped !== part) {
        messageChanged = true;
      }
      return stripped;
    });
    if (!messageChanged) {
      return message;
    }
    changed = true;
    return { ...message, content };
  });
  return changed ? (next as LanguageModelV3Prompt) : prompt;
}

function hasRecycledRawIds(prompt: LanguageModelV3Prompt): boolean {
  const seen = new Set<string>();
  for (const message of prompt) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (part.type !== 'tool-call' || isTaggedToolCallId(part.toolCallId)) {
        continue;
      }
      if (seen.has(part.toolCallId)) {
        return true;
      }
      seen.add(part.toolCallId);
    }
  }
  return false;
}

/**
 * Bidirectional tool-call id normalization (AGE-378).
 *
 * Providers such as OpenAI-compatible models served through Bedrock Mantle
 * mint per-response sequential tool-call ids (`call_0`, `call_1`, …) that
 * RESET on every model response, so `toolCallId` is not unique within a
 * conversation and every id-keyed map, dedup, and durable record above the
 * SDK silently breaks.
 *
 * Inbound (`wrapStream`/`wrapGenerate`, tagged providers only): every
 * non-provider-executed tool id gains `_ap_<8-char nonce>` minted once per
 * model call — the exact scope over which providers reset their counters —
 * so everything above the SDK observes unique ids.
 *
 * Outbound (`transformParams`, EVERY provider): the suffix is stripped, so
 * the wire carries exactly the ids the provider issued. Universal because
 * sessions switch models mid-conversation and persisted history carries
 * tagged ids into other vendors — which reject foreign shapes (Bedrock
 * validates `toolUseId` against `[a-zA-Z0-9_-]+`, AGE-378 V12).
 *
 * Must sit INNERMOST (closest to the provider): registered automatically by
 * `wrapModelWithKernelMiddlewares`, never at consumer call sites.
 */
export class ToolCallIdNormalizationMiddleware implements KernelModelMiddleware {
  readonly #provider: string | undefined;
  readonly #nonceFactory: () => string;
  #recycledIdsReported = false;

  constructor(provider: string | undefined, nonceFactory?: () => string) {
    this.#provider = provider;
    this.#nonceFactory = nonceFactory ?? (() => generateShortId(8));
  }

  create(_ctx: KernelModelMiddlewareContext): LanguageModelMiddleware {
    const tagging = shouldTagProvider(this.#provider);

    return {
      specificationVersion: 'v3',

      transformParams: async ({ params }: { params: LanguageModelV3CallOptions }) => {
        if (!tagging && !this.#recycledIdsReported && hasRecycledRawIds(params.prompt)) {
          this.#recycledIdsReported = true;
          logger.warn(
            '[ToolCallIdNormalization] recycled raw tool-call ids on a non-tagged provider',
            {
              provider: this.#provider,
            },
          );
        }
        const stripped = stripPromptIds(params.prompt);
        if (stripped === params.prompt) {
          return params;
        }
        return { ...params, prompt: stripped };
      },

      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        if (!tagging) {
          return result;
        }
        const nonce = this.#nonceFactory();
        const content = result.content.map((part) => {
          if (part.type !== 'tool-call' || part.providerExecuted === true) {
            return part;
          }
          return { ...part, toolCallId: `${part.toolCallId}${TOOL_CALL_ID_MARKER}${nonce}` };
        });
        return { ...result, content };
      },

      wrapStream: async ({ doStream }) => {
        const { stream, ...rest } = await doStream();
        if (!tagging) {
          return { stream, ...rest };
        }
        const nonce = this.#nonceFactory();
        const taggedIds = new Map<string, string>();
        const providerExecutedIds = new Set<string>();

        const tag = (id: string): string => {
          const existing = taggedIds.get(id);
          if (existing) {
            return existing;
          }
          const tagged = `${id}${TOOL_CALL_ID_MARKER}${nonce}`;
          taggedIds.set(id, tagged);
          return tagged;
        };

        return {
          stream: stream.pipeThrough(
            new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
              transform(part, controller) {
                if (part.type === 'tool-input-start') {
                  if (part.providerExecuted === true) {
                    providerExecutedIds.add(part.id);
                    controller.enqueue(part);
                    return;
                  }
                  controller.enqueue({ ...part, id: tag(part.id) });
                  return;
                }
                if (part.type === 'tool-input-delta' || part.type === 'tool-input-end') {
                  if (providerExecutedIds.has(part.id)) {
                    controller.enqueue(part);
                    return;
                  }
                  controller.enqueue({ ...part, id: tag(part.id) });
                  return;
                }
                if (part.type === 'tool-call' || part.type === 'tool-result') {
                  const providerExecuted =
                    ('providerExecuted' in part && part.providerExecuted === true) ||
                    providerExecutedIds.has(part.toolCallId);
                  if (providerExecuted) {
                    controller.enqueue(part);
                    return;
                  }
                  controller.enqueue({ ...part, toolCallId: tag(part.toolCallId) });
                  return;
                }
                controller.enqueue(part);
              },
            }),
          ),
          ...rest,
        };
      },
    };
  }
}
