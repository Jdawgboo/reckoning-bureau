export interface AgentLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const noopLogger: AgentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let globalLogger: AgentLogger = console;

export function setAgentLogger(logger: AgentLogger): void {
  globalLogger = logger;
}

/**
 * Returns a proxy that always delegates to the current globalLogger.
 * Safe to capture at module level — calls are forwarded dynamically,
 * so `setAgentLogger()` takes effect even after the reference is stored.
 */
const loggerProxy: AgentLogger = {
  debug(message: string, meta?: Record<string, unknown>) {
    globalLogger.debug(message, meta);
  },
  info(message: string, meta?: Record<string, unknown>) {
    globalLogger.info(message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>) {
    globalLogger.warn(message, meta);
  },
  error(message: string, meta?: Record<string, unknown>) {
    globalLogger.error(message, meta);
  },
};

export function getAgentLogger(): AgentLogger {
  return loggerProxy;
}
