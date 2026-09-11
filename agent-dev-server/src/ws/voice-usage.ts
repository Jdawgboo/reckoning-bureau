/**
 * Per-agent voice metering: a monthly realtime-minutes counter on the agent's
 * StateTree (durable via the platform state service, so it survives VM
 * restarts). `monthlyMinutesCap` from `agentConfig().voice` is enforced at
 * session start; recording is fail-open — a metering write must never break
 * a live voice session.
 */
import type { StateTree } from '../bl/agent/agent-library.ts';
import { isRecord } from '../util/type-guards.ts';
import { log } from '../util/logger.ts';

const USAGE_PATH_PREFIX = '/data/voice/usage/';

function monthKey(now: Date): string {
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${now.getUTCFullYear()}-${month}`;
}

export class VoiceUsageMeter {
  #stateTree: StateTree | null;

  constructor(stateTree: StateTree | null) {
    this.#stateTree = stateTree;
  }

  async minutesUsedThisMonth(): Promise<number> {
    if (!this.#stateTree) {
      return 0;
    }
    try {
      const value = await this.#stateTree.get(`${USAGE_PATH_PREFIX}${monthKey(new Date())}`);
      if (isRecord(value) && typeof value['minutes'] === 'number') {
        return value['minutes'];
      }
    } catch (error) {
      log('warn', {
        event: 'voice.usage.read.failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return 0;
  }

  /** True when the session may start under the given cap (unset cap = unlimited). */
  async underCap(monthlyMinutesCap: number | undefined): Promise<boolean> {
    if (monthlyMinutesCap === undefined) {
      return true;
    }
    return (await this.minutesUsedThisMonth()) < monthlyMinutesCap;
  }

  /** Adds a finished session's duration to this month's counter (fail-open). */
  async recordSessionMs(durationMs: number): Promise<void> {
    if (!this.#stateTree || durationMs <= 0) {
      return;
    }
    const minutes = Math.ceil(durationMs / 60_000);
    const path = `${USAGE_PATH_PREFIX}${monthKey(new Date())}`;
    try {
      const current = await this.minutesUsedThisMonth();
      await this.#stateTree.set(path, { minutes: current + minutes });
      log('info', { event: 'voice.usage.recorded', minutes, monthTotal: current + minutes });
    } catch (error) {
      log('warn', {
        event: 'voice.usage.write.failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
