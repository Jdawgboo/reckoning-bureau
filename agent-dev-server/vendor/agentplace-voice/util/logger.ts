export interface VoiceLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

let globalLogger: VoiceLogger = console;

/** Lets a consumer (e.g. the platform server) route this library's logs through its own logger. */
export function setVoiceLogger(logger: VoiceLogger): void {
  globalLogger = logger;
}

/**
 * Returns a proxy that always delegates to the current globalLogger.
 * Safe to capture at module level — calls are forwarded dynamically,
 * so `setVoiceLogger()` takes effect even after the reference is stored.
 */
const loggerProxy: VoiceLogger = {
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

export function getVoiceLogger(): VoiceLogger {
  return loggerProxy;
}
