// File logger — implements Logger port with AsyncLocalStorage traceId + rotation.
// Writes are async (buffered → periodic flush) to avoid blocking the event loop.

import { appendFile } from 'node:fs/promises'
import { existsSync, mkdirSync, statSync, renameSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Logger, LogLevel } from '../../application/ports/logger'
import { MB } from '../../application/constants/units'

const LEVEL_ORDER: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3, off: 4 }
const als = new AsyncLocalStorage<{ traceId?: string }>()
const FLUSH_MS = 1000
const DEFAULT_MAX_FILES = 5
const TRACE_ID_PREVIEW_CHARS = 8
const LOG_LEVEL_PAD_LENGTH = 5

export class FileLogger implements Logger {
  private level: LogLevel
  private logPath: string | null
  private maxSize: number
  private maxFiles: number
  private console: boolean
  private buffer: string[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private draining = false

  constructor(opts?: { level?: LogLevel; path?: string; maxSize?: number; maxFiles?: number; console?: boolean }) {
    this.level = opts?.level ?? 'info'
    this.logPath = opts?.path ?? null
    this.maxSize = opts?.maxSize ?? 10 * MB
    this.maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES
    this.console = opts?.console ?? false
    if (this.logPath) {
      const dir = this.logPath!.split('/').slice(0, -1).join('/')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    }
    // Always start flush timer (handles both file and no-file modes)
    this.timer = setInterval(() => {
      this.flush().catch(err => {
        process.stderr.write(`[FileLogger] flush failed: ${String(err)}\n`)
      })
    }, FLUSH_MS)
    this.timer.unref()
  }

  withTag(tag: string): Logger {
    const parent = this
    return {
      debug: (_, msg) => parent.enqueue('DEBUG', tag, msg),
      info:  (_, msg) => parent.enqueue('INFO',  tag, msg),
      warn:  (_, msg) => parent.enqueue('WARN',  tag, msg),
      error: (_, msg) => parent.enqueue('ERROR', tag, msg),
      withTag: (t) => parent.withTag(t),
    }
  }

  debug(tag: string, msg: string): void { this.enqueue('DEBUG', tag, msg) }
  info(tag: string, msg: string): void { this.enqueue('INFO', tag, msg) }
  warn(tag: string, msg: string): void { this.enqueue('WARN', tag, msg) }
  error(tag: string, msg: string): void { this.enqueue('ERROR', tag, msg) }

  /** Shutdown: flush remaining and stop timer */
  async close(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    await this.flush()
  }

  private enqueue(level: string, tag: string, msg: string): void {
    if ((LEVEL_ORDER[level.toLowerCase()] ?? -1) < (LEVEL_ORDER[this.level] ?? 0)) return
    const store = als.getStore()
    const trace = store?.traceId ? ` [${store.traceId.slice(0, TRACE_ID_PREVIEW_CHARS)}]` : ''
    this.buffer.push(`${new Date().toISOString()} ${level.padEnd(LOG_LEVEL_PAD_LENGTH)} [${tag}]${trace} ${msg}`)
    // Flush immediately for errors, or if buffer grows large
    if (level === 'ERROR' || this.buffer.length > 100) {
      void this.flush()
    }
  }

  private async flush(): Promise<void> {
    if (this.draining || this.buffer.length === 0) return
    this.draining = true
    const batch = this.buffer.splice(0, this.buffer.length)
    // Console output (stderr, non-blocking)
    if (this.console || !this.logPath) {
      for (const line of batch) process.stderr.write(line + '\n')
    }
    // File output
    if (this.logPath) {
      this.rotate()
      const chunk = batch.join('\n') + '\n'
      try { await appendFile(this.logPath, chunk) } catch {}
    }
    this.draining = false
  }

  private rotate(): void {
    if (!this.logPath || !existsSync(this.logPath)) return
    try {
      const size = statSync(this.logPath).size
      if (size < this.maxSize) return
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const old = `${this.logPath}.${i}`
        const next = `${this.logPath}.${i + 1}`
        if (existsSync(old)) { try { renameSync(old, next) } catch {} }
      }
      renameSync(this.logPath, `${this.logPath}.1`)
    } catch {}
  }
}
