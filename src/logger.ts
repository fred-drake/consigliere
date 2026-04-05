export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function createLogger(
  level: LogLevel,
  output: { write(s: string): void }
): Logger {
  const minLevel = LEVEL_ORDER[level];

  function log(
    lvl: LogLevel,
    message: string,
    context?: Record<string, unknown>
  ): void {
    if (LEVEL_ORDER[lvl] < minLevel) return;

    const entry: Record<string, unknown> = {
      ...context,
      level: lvl,
      message,
      ts: new Date().toISOString(),
    };

    output.write(JSON.stringify(entry) + "\n");
  }

  return {
    debug: (msg, ctx) => log("debug", msg, ctx),
    info: (msg, ctx) => log("info", msg, ctx),
    warn: (msg, ctx) => log("warn", msg, ctx),
    error: (msg, ctx) => log("error", msg, ctx),
  };
}
