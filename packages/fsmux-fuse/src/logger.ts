/**
 * The logging surface a server accepts. Deliberately structural and declared
 * here rather than imported: four method signatures are not worth a shared
 * dependency, and any logger with them (pino, console-shaped, a test spy)
 * satisfies it without an adapter.
 */
export interface Logger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** The default: say nothing unless the caller asked for logs. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
