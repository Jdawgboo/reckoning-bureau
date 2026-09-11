import { getAgentLogger } from '../../types/logger.ts';
import type { CacheStrategy } from './cache-strategy.interface.ts';
import { ClaudeCacheStrategy } from './anthropic/claude-cache.strategy.ts';
import { OpenRouterClaudeCacheStrategy } from './anthropic/openrouter-claude-cache.strategy.ts';
import { BedrockCacheStrategy } from './anthropic/bedrock-cache.strategy.ts';
import { NoCacheStrategy } from './no-cache.strategy.ts';

export type CacheStrategyFactoryConfig = {
  /**
   * Bedrock non-system cache-point TTL. Omitted or `'5m'` emits no ttl field
   * (provider default). `'1h'` survives 5–60 minute pauses between turns but
   * charges a 1.6x write premium on every incremental suffix write — fleet
   * measurement 2026-07-20 found unconditional `'1h'` net-negative, so it is a
   * runtime knob rather than a default. System messages always use `'1h'`
   * regardless; only message cache points are affected.
   */
  bedrockMessageTtl?: '5m' | '1h';

  /** Custom strategies to use instead of defaults */
  strategies?: CacheStrategy[];
  /** Whether to include default strategies (default: true) */
  includeDefaults?: boolean;
};

/**
 * Factory for selecting the appropriate cache strategy based on model and provider.
 *
 * By default, includes strategies for:
 * - Anthropic Claude (direct API)
 * - Bedrock Claude
 * - OpenRouter Claude
 * - No-cache fallback
 *
 * @example
 * // Use default strategies
 * const factory = new CacheStrategyFactory();
 *
 * @example
 * // Use custom strategies only
 * const factory = new CacheStrategyFactory({
 *   strategies: [new MyCustomStrategy()],
 *   includeDefaults: false,
 * });
 *
 * @example
 * // Add custom strategy before defaults
 * const factory = new CacheStrategyFactory({
 *   strategies: [new MyCustomStrategy()],
 * });
 */
export class CacheStrategyFactory {
  private strategies: CacheStrategy[];

  constructor(config: CacheStrategyFactoryConfig = {}) {
    const { strategies = [], includeDefaults = true, bedrockMessageTtl } = config;

    if (includeDefaults) {
      this.strategies = [
        ...strategies,
        new ClaudeCacheStrategy(),
        new OpenRouterClaudeCacheStrategy(),
        new BedrockCacheStrategy(bedrockMessageTtl ? { messageTtl: bedrockMessageTtl } : {}),
        new NoCacheStrategy(),
      ];
    } else {
      this.strategies = strategies.length > 0 ? strategies : [new NoCacheStrategy()];
    }
  }

  getStrategy(modelId: string | undefined, provider: string | undefined): CacheStrategy {
    const logger = getAgentLogger();
    const strategy = this.strategies.find((s) => s.canHandle(modelId, provider));
    if (!strategy) {
      logger.warn(`No cache strategy for model=${modelId} provider=${provider ?? 'unknown'}`);
      return new NoCacheStrategy();
    }
    logger.debug(
      `Using ${strategy.getName()} for model=${modelId} provider=${provider ?? 'unknown'}`,
    );
    return strategy;
  }

  registerStrategy(strategy: CacheStrategy): void {
    this.strategies.unshift(strategy);
  }
}
