// Logger port —防腐层 interface. Uses AsyncLocalStorage for traceId.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(tag: string, msg: string): void
  info(tag: string, msg: string): void
  warn(tag: string, msg: string): void
  error(tag: string, msg: string): void
  /** Return a logger pre-bound to the given tag */
  withTag(tag: string): Logger
}


