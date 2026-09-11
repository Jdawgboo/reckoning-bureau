import { setAgentLogger, type AgentLogger } from '../../vendor/agent-library/index';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

function resolveLevel(): Level {
  const raw = (process.env.AGENT_LOG_LEVEL ?? 'info').toLowerCase();
  return raw in LEVELS ? (raw as Level) : 'info';
}

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (meta === undefined) {
    fn(message);
  } else {
    fn(message, meta);
  }
}

/**
 * Route agent-library logs through a level-gated logger (default `info`, set
 * `AGENT_LOG_LEVEL=debug` for the full firehose). Without this the library's
 * `getAgentLogger()` falls back to raw `console`, so every debug line prints.
 */
export function installAgentLogger(): void {
  const threshold = LEVELS[resolveLevel()];
  const logger: AgentLogger = {
    debug: (m, meta) => threshold <= LEVELS.debug && emit('debug', m, meta),
    info: (m, meta) => threshold <= LEVELS.info && emit('info', m, meta),
    warn: (m, meta) => threshold <= LEVELS.warn && emit('warn', m, meta),
    error: (m, meta) => threshold <= LEVELS.error && emit('error', m, meta),
  };
  setAgentLogger(logger);
}
