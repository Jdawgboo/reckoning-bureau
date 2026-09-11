import type { LanguageModelV3Message } from '@ai-sdk/provider';
import { ClaudeCacheStrategy, type ClaudeCacheStrategyConfig } from './claude-cache.strategy.ts';

export type BedrockCacheStrategyConfig = ClaudeCacheStrategyConfig & {
  /**
   * TTL for non-system cache points. '5m' (default) emits no ttl field — the
   * provider default. '1h' survives 5m–60m pauses between turns but charges a
   * 1.6x write premium on EVERY incremental suffix write, not just the ones
   * that would expire. Fleet measurement 2026-07-20: unconditional '1h' was
   * net-negative (premium 11.9k raw vs 2.5k saved; most idle gaps exceed 1h,
   * where '1h' expires too) — see specs/2026-07-20-cache-ttl-and-mantle-cache.
   */
  messageTtl?: '5m' | '1h';
};

export class BedrockCacheStrategy extends ClaudeCacheStrategy {
  protected supportedProviders = ['amazon-bedrock'];
  readonly #messageTtl: '5m' | '1h';

  constructor(config: BedrockCacheStrategyConfig = {}) {
    super(config);
    this.#messageTtl = config.messageTtl ?? '5m';
  }

  canHandle(modelId: string | undefined, aiSdkProvider: string | undefined): boolean {
    if (!aiSdkProvider || !modelId) {
      return false;
    }
    if (aiSdkProvider !== 'amazon-bedrock') {
      return false;
    }
    // Check if it's a Claude model on Bedrock
    return modelId.toLowerCase().includes('claude') || modelId.toLowerCase().includes('anthropic');
  }

  getName(): string {
    return 'BedrockClaudeCacheStrategy';
  }

  protected applyCacheControl(message: LanguageModelV3Message): void {
    let ttl: '1h' | undefined;
    if (message.role === 'system') {
      ttl = '1h';
    } else if (this.#messageTtl === '1h') {
      ttl = '1h';
    }
    (message as any).providerOptions = {
      ...((message as any).providerOptions || {}),
      bedrock: { cachePoint: { type: 'default', ...(ttl ? { ttl } : {}) } },
    };
  }
}
