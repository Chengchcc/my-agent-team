// Worker-side runtime helper for the spawn LLM bridge.
// Workers that want to participate in the stdio NDJSON RPC protocol
// wrap their `handle()` call in `runWorker()` instead of hand-writing
// the protocol.

import { FrameDecoder, encodeFrame, type Frame } from './spawn-rpc/frame'
import type { JobContext } from '../../application/ports/job-spawner'

/** Local invoke timeout in the worker — slightly longer than the parent's
 *  invokeTimeoutMs to avoid races where both sides time out independently. */
const WORKER_INVOKE_TIMEOUT_MS = 70_000

/** Local chatComplete timeout in the worker. */
const WORKER_CHAT_TIMEOUT_MS = 70_000

/** Grace period after stdin EOF before the worker force-exits. */
const STDIN_EOF_EXIT_DELAY_MS = 5_000

interface PendingEntry {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Run a job handler inside the spawn worker protocol.
 *
 * The handler receives the deserialized job from the parent's `init` frame
 * and a `JobContext` whose `invoke()`, `chatComplete()`, and `log()` calls
 * are proxied over stdout NDJSON frames. The parent process services
 * `invoke-req` frames by calling its own ProviderInvoke and `chat-req`
 * frames by calling its own ProviderChat.complete.
 */
export async function runWorker(
  handler: (job: unknown, ctx: JobContext) => Promise<unknown>,
): Promise<void> {
  const decoder = new FrameDecoder()
  const pending = new Map<string, PendingEntry>()
  const pendingChat = new Map<string, PendingEntry>()
  let initialised = false
  let exited = false

  const writeFrame = (f: Frame): void => {
    process.stdout.write(encodeFrame(f))
  }

  const cancelAllPending = (reason: string): void => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    pending.clear()
    for (const [, entry] of pendingChat) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    pendingChat.clear()
  }

  const ctx: JobContext = {
    invoke: (req) => {
      return new Promise<{ content: string; usage: { input: number; output: number } }>(
        (resolve, reject) => {
          const id = crypto.randomUUID()
          const timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error('worker invoke timeout'))
          }, WORKER_INVOKE_TIMEOUT_MS)
          pending.set(id, {
            resolve: resolve as (v: unknown) => void,
            reject: reject as (e: unknown) => void,
            timer,
          })
          writeFrame({
            v: 1,
            id,
            kind: 'invoke-req',
            ts: Date.now(),
            payload: req,
          })
        },
      )
    },
    chatComplete: (req) => {
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID()
        const timer = setTimeout(() => {
          pendingChat.delete(id)
          reject(new Error('worker chatComplete timeout'))
        }, WORKER_CHAT_TIMEOUT_MS)
        pendingChat.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject: reject as (e: unknown) => void,
          timer,
        })
        writeFrame({ v: 1, id, kind: 'chat-req', ts: Date.now(), payload: req })
      })
    },
    log: (level, msg) => {
      writeFrame({
        v: 1,
        id: crypto.randomUUID(),
        kind: 'log',
        ts: Date.now(),
        payload: { level, msg },
      })
    },
  }

  const handleInit = async (frame: Frame): Promise<void> => {
    initialised = true
    try {
      try {
        const payload = frame.payload as Record<string, unknown>
        const job = payload.job
        const result = await handler(job, ctx)
        if (exited) { process.exit(0); return }
        writeFrame({
          v: 1,
          id: crypto.randomUUID(),
          kind: 'result',
          ts: Date.now(),
          payload: result,
        })
        process.exit(0)
      } catch (err) {
        if (exited) { process.exit(1); return }
        writeFrame({
          v: 1,
          id: crypto.randomUUID(),
          kind: 'error',
          ts: Date.now(),
          payload: {
            code: 'INTERNAL',
            message: err instanceof Error ? err.message : String(err),
          },
        })
        process.exit(1)
      }
    } finally {
      // Safety net: if any path misses process.exit, force exit after grace period
      setTimeout(() => process.exit(1), 1000).unref()
    }
  }

  const handleData = (chunk: Buffer): void => {
    for (const frame of decoder.push(chunk)) {
      switch (frame.kind) {
        case 'init':
          if (!initialised) {
            // Fire-and-forget — handler runs async while we keep reading frames
            handleInit(frame).catch(() => {
              /* caught inside handleInit */
            })
          }
          break

        case 'invoke-resp': {
          const entry = pending.get(frame.id)
          if (entry) {
            clearTimeout(entry.timer)
            pending.delete(frame.id)
            entry.resolve(frame.payload)
          }
          break
        }

        case 'chat-resp': {
          const entry = pendingChat.get(frame.id)
          if (entry) {
            clearTimeout(entry.timer)
            pendingChat.delete(frame.id)
            entry.resolve(frame.payload)
          }
          break
        }

        case 'chat-error': {
          const entry = pendingChat.get(frame.id)
          if (entry) {
            clearTimeout(entry.timer)
            pendingChat.delete(frame.id)
            const payload = frame.payload as { code?: string; message?: string }
            entry.reject(
              new Error(
                `chat error [${payload.code ?? 'UNKNOWN'}]: ${payload.message ?? 'no message'}`,
              ),
            )
          }
          break
        }

        case 'error': {
          const entry = pending.get(frame.id)
          if (entry) {
            clearTimeout(entry.timer)
            pending.delete(frame.id)
            const payload = frame.payload as { code?: string; message?: string }
            entry.reject(
              new Error(
                `worker rpc error [${payload.code ?? 'UNKNOWN'}]: ${payload.message ?? 'no message'}`,
              ),
            )
          }
          // Also check pendingChat — an error frame might match a chat request
          const chatEntry = pendingChat.get(frame.id)
          if (chatEntry) {
            clearTimeout(chatEntry.timer)
            pendingChat.delete(frame.id)
            const payload = frame.payload as { code?: string; message?: string }
            chatEntry.reject(
              new Error(
                `worker rpc error [${payload.code ?? 'UNKNOWN'}]: ${payload.message ?? 'no message'}`,
              ),
            )
          }
          break
        }

        case 'shutdown': {
          const payload = frame.payload as { reason?: string }
          cancelAllPending(`shutdown: ${payload.reason ?? 'parent-requested'}`)
          exited = true
          setTimeout(() => process.exit(0), 100)
          break
        }

        // The parent should never send these, but be defensive.
        case 'invoke-req':
        case 'result':
        case 'log':
        case 'chat-req':
        case 'tool-call-req':
        case 'tool-call-resp':
          break
      }
    }
  }

  // stdin may be paused — resume it.
  if (process.stdin.isPaused()) {
    process.stdin.resume()
  }

  process.stdin.on('data', handleData)

  // Detect parent death via stdin EOF.
  process.stdin.on('end', () => {
    cancelAllPending('parent stdin closed')
    exited = true
    setTimeout(() => process.exit(1), STDIN_EOF_EXIT_DELAY_MS)
  })
}
