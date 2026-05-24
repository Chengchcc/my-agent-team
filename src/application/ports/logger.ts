// Logger port —防腐层 interface. Uses AsyncLocalStorage for traceId.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(tag: string, msg: string, fields?: Record<string, unknown>): void
  info(tag: string, msg: string, fields?: Record<string, unknown>): void
  warn(tag: string, msg: string, fields?: Record<string, unknown>): void
  error(tag: string, msg: string, fields?: Record<string, unknown>): void
  /** Return a logger pre-bound to the given tag */
  withTag(tag: string): Logger
}


