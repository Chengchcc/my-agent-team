/// <reference types="bun" />

import type { JobSpawner } from '../../application/ports/job-spawner'
import type { JobContext } from '../../application/ports/job-spawner'
import type { Logger } from '../../application/ports/logger'
import type { ProviderInvoke } from '../../application/ports/provider'
import { FrameDecoder, encodeFrame, type Frame } from './spawn-rpc/frame'

/** Purposes that workers are allowed to request via invoke-req. */
const PURPOSE_WHITELIST = new Set([
  'evolution.review.tier0',
  'evolution.review.tier2',
  'memory.extract',
])

/** Hard cap on serialised message size for invoke-req payloads. */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers
const MAX_MESSAGE_SIZE = 128 * 1024 // 128KB

const SIGKILL = 9
const SHUTDOWN_GRACE_MS = 5_000

interface SpawnConfig {
  invokeTimeoutMs: number
  lifetimeMs: number
}

/**
 * Spawns a short-lived Bun worker that communicates with the parent
 * via NDJSON bidirectional RPC over stdio. The worker can call back
 * into the parent's ProviderInvoke via invoke-req frames.
 */
export class BunSpawnJobSpawner implements JobSpawner {
  constructor(
    private invoke: ProviderInvoke,
    private logger: Logger,
    private cfg: SpawnConfig,
  ) {}

  async run<TJob, TResult>(opts: {
    entry: string
    job: TJob
    ctx: JobContext
    timeoutMs?: number
  }): Promise<TResult> {
    const spawnId = crypto.randomUUID()
    const jobType = this.inferJobType(opts.entry)
    const startTime = Date.now()

    this.logger.info('spawn', `starting worker [${jobType}]`, { jobType })

    const child = Bun.spawn({
      cmd: ['bun', 'run', opts.entry],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    })

    this.logger.info('spawn', `worker started [${jobType}] pid=${child.pid}`, {
      jobType,
      pid: child.pid,
    })

    const decoder = new FrameDecoder()
    const lifetimeMs = opts.timeoutMs ?? this.cfg.lifetimeMs

    const lifetimeTimer = setTimeout(() => {
      this.killChild(child, 'lifetime-timeout', jobType)
    }, lifetimeMs)

    try {
      // Send init frame
      void child.stdin.write(
        encodeFrame({
          v: 1,
          id: spawnId,
          kind: 'init',
          ts: Date.now(),
          payload: {
            jobType,
            job: opts.job,
            config: { invokeTimeoutMs: this.cfg.invokeTimeoutMs },
          },
        }),
      )

      const reader = child.stdout.getReader()
      let resultFrame: Frame | null = null

      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break

          for (const frame of decoder.push(value as Buffer)) {
            switch (frame.kind) {
              case 'invoke-req':
                await this.handleInvokeReq(frame, child.stdin, jobType, spawnId)
                break
              case 'log':
                this.relayLog(frame, child.pid, jobType)
                break
              case 'result':
                resultFrame = frame
                break
              case 'error': {
                const payload = frame.payload as { code?: string; message?: string }
                throw new Error(
                  `worker error [${jobType}]: ${payload.message ?? 'unknown'}`,
                )
              }
              // Frames that should not arrive from the worker (parent→worker only).
              case 'init':
              case 'invoke-resp':
              case 'shutdown':
                break
            }
          }

          if (resultFrame) break
        }
      } finally {
        clearTimeout(lifetimeTimer)
        try {
          reader.releaseLock()
        } catch {
          /* reader may already be released */
        }
      }

      if (!resultFrame) {
        const exitCode = child.exitCode
        throw new Error(
          `worker exited without result [${jobType}] pid=${child.pid} code=${exitCode}`,
        )
      }

      // Wait for the worker to exit gracefully before returning.
      await child.exited

      const durationMs = Date.now() - startTime
      this.logger.info(
        'spawn',
        `worker finished [${jobType}] pid=${child.pid} duration=${durationMs}ms`,
        { jobType, pid: child.pid, durationMs },
      )

      return (resultFrame.payload as Record<string, unknown>) as unknown as TResult
    } catch (err) {
      // Ensure child is dead on error path
      try {
        child.kill(SIGKILL)
      } catch {
        /* already dead */
      }
      throw err
    }
  }

  private async handleInvokeReq(
    frame: Frame,
    stdin: { write: (d: Uint8Array | string) => number | Promise<number> },
    jobType: string,
    spawnId: string,
  ): Promise<void> {
    const payload = frame.payload as {
      purpose?: string
      messages?: Array<{ role: string; content: string }>
      maxTokens?: number
    }

    // Purpose whitelist — security boundary
    if (!payload.purpose || !PURPOSE_WHITELIST.has(payload.purpose)) {
      void stdin.write(
        encodeFrame({
          v: 1,
          id: frame.id,
          kind: 'error',
          ts: Date.now(),
          payload: {
            code: 'PROVIDER_FAIL',
            message: `purpose not in whitelist: ${payload.purpose ?? 'missing'}`,
          },
        }),
      )
      return
    }

    // Message size cap
    const raw = JSON.stringify(payload.messages ?? [])
    if (raw.length > MAX_MESSAGE_SIZE) {
      void stdin.write(
        encodeFrame({
          v: 1,
          id: frame.id,
          kind: 'error',
          ts: Date.now(),
          payload: {
            code: 'PROVIDER_FAIL',
            message: `messages exceed ${MAX_MESSAGE_SIZE} byte limit`,
          },
        }),
      )
      return
    }

    const startTime = Date.now()
    const timer = setTimeout(() => {
      void stdin.write(
        encodeFrame({
          v: 1,
          id: frame.id,
          kind: 'error',
          ts: Date.now(),
          payload: {
            code: 'TIMEOUT',
            message: `invoke timeout after ${this.cfg.invokeTimeoutMs}ms`,
          },
        }),
      )
    }, this.cfg.invokeTimeoutMs)

    try {
      const resp = await this.invoke.call({
        kind: 'internal',
        purpose: payload.purpose,
        parentTurnId: `${payload.purpose}:${spawnId}`,
        messages: payload.messages ?? [],
        maxTokens: payload.maxTokens,
      })
      clearTimeout(timer)
      void stdin.write(
        encodeFrame({
          v: 1,
          id: frame.id,
          kind: 'invoke-resp',
          ts: Date.now(),
          payload: { content: resp.content, usage: resp.usage },
        }),
      )

      const latencyMs = Date.now() - startTime
      this.logger.info(
        'spawn',
        `invoke ok [${jobType}] purpose=${payload.purpose} latency=${latencyMs}ms`,
        { jobType, purpose: payload.purpose, latencyMs },
      )
    } catch (err) {
      clearTimeout(timer)
      void stdin.write(
        encodeFrame({
          v: 1,
          id: frame.id,
          kind: 'error',
          ts: Date.now(),
          payload: {
            code: 'PROVIDER_FAIL',
            message: err instanceof Error ? err.message : String(err),
          },
        }),
      )
    }
  }

  private relayLog(frame: Frame, pid: number, jobType: string): void {
    const payload = frame.payload as { level?: string; msg?: string }
    const msg = payload.msg ?? ''
    const prefix = `[worker ${jobType} pid=${pid}]`
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- default handles undefined
    switch (payload.level) {
      case 'error':
        this.logger.error('spawn', `${prefix} ${msg}`)
        break
      case 'warn':
        this.logger.warn('spawn', `${prefix} ${msg}`)
        break
      default:
        this.logger.info('spawn', `${prefix} ${msg}`)
        break
    }
  }

  private killChild(
    child: {
      stdin: { write: (d: Uint8Array | string) => number | Promise<number> }
      kill: (sig: number) => void
    },
    reason: string,
    jobType: string,
  ): void {
    this.logger.warn('spawn', `killing worker [${jobType}] reason=${reason}`, {
      jobType,
      reason,
    })
    void child.stdin.write(
      encodeFrame({
        v: 1,
        id: crypto.randomUUID(),
        kind: 'shutdown',
        ts: Date.now(),
        payload: { reason },
      }),
    )
    setTimeout(() => {
      try {
        child.kill(SIGKILL)
      } catch {
        /* child already dead */
      }
    }, SHUTDOWN_GRACE_MS)
  }

  private inferJobType(entry: string): string {
    if (entry.includes('worker-entry')) return 'evolution.review'
    if (entry.includes('extract-worker')) return 'memory.extract'
    return 'unknown'
  }
}
