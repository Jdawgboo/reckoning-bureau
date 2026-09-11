import type { LanguageModelUsage } from 'ai';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import type { Attachment } from '../../core/interfaces.ts';

/**
 * TurnProcessor
 *
 * A turn-level hook that is conceptually different from model middlewares:
 * - Runs once per agent turn (not per model call / per step).
 * - May intentionally commit changes into canonical conversation history.
 */
export interface TurnProcessorState {
  // turn input idempotency helpers
  hasTurnInputInjected(): boolean;
  markTurnInputInjected(): void;

  // current turn input
  getUserQueryText(): string | undefined;
  getLastUsage(): LanguageModelUsage | undefined;
  getAttachments(): Attachment[];

  // canonical history
  getConversationHistory(): ModelMessage[];
  setConversationHistory(history: ModelMessage[]): void;
}

export interface TurnProcessor {
  process(state: TurnProcessorState): Promise<ModelMessage[] | null>;

  /**
   * When true, this processor's output shapes the PROMPT only and is never written back to the
   * canonical log.
   *
   * `design.md:20` — "One append-only log. The prompt is a pure projection of it." Most
   * processors genuinely add facts (a system prompt, the turn's user message) and belong in the
   * log. A REPAIR does not: it rewrites messages that already exist so the provider will accept
   * them, which is a rendering concern.
   *
   * Writing a repair back to the log caused the PROD 2026-07-30 failure class — the writer's
   * diff cannot distinguish a rewrite from an injection, so repairs were committed alongside the
   * originals they replaced, and synthesised results became permanent history. Declaring the
   * processor a projection removes that possibility structurally instead of relying on care.
   */
  readonly projection?: boolean;
}
