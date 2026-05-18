import pino from "pino";

const LEVEL = (process.env.ATELI_LOG_LEVEL ?? "info") as
  | "trace"
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "fatal";

export const logger = pino({
  level: LEVEL,
  transport: process.stdout.isTTY
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      }
    : undefined,
});

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
