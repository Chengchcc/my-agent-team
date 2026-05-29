// Worker-side runtime helper for the spawn LLM bridge.
// Workers that want to participate in the stdio NDJSON RPC protocol
// wrap their `handle()` call in `runWorker()` instead of hand-writing
// the protocol.

import { FrameDecoder, encodeFrame, type Frame } from './spawn-rpc/frame'
import type { JobContext } from '../../application/ports/job-spawner'

const WORKER_INVOKE_TIMEOUT_MS = 70_000
const WORKER_CHAT_TIMEOUT_MS = 70_000
const STDIN_EOF_EXIT_DELAY_MS = 5_000

interface PendingEntry {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

interface WorkerState {
  pending: Map<string, PendingEntry>
  pendingChat: Map<string, PendingEntry>
  initialised: boolean
  exited: boolean
  writeFrame: (f: Frame) => void
}

function createWorkerContext(state: WorkerState): JobContext {
  return {
    invoke: (req) => {
      return new Promise<{ content: string; usage: { input: number; output: number } }>(
        (resolve, reject) => {
          const id = crypto.randomUUID()
          const timer = setTimeout(() => {
            state.pending.delete(id)
            reject(new Error('worker invoke timeout'))
          }, WORKER_INVOKE_TIMEOUT_MS)
          state.pending.set(id, {
            resolve: resolve as (v: unknown) => void,
            reject: reject as (e: unknown) => void,
            timer,
          })
          state.writeFrame({ v: 1, id, kind: 'invoke-req', ts: Date.now(), payload: req })
        },
      )
    },
    chatComplete: (req) => {
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID()
        const timer = setTimeout(() => {
          state.pendingChat.delete(id)
          reject(new Error('worker chatComplete timeout'))
        }, WORKER_CHAT_TIMEOUT_MS)
        state.pendingChat.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject: reject as (e: unknown) => void,
          timer,
        })
        state.writeFrame({ v: 1, id, kind: 'chat-req', ts: Date.now(), payload: req })
      })
    },
    log: (level, msg) => {
      state.writeFrame({
        v: 1, id: crypto.randomUUID(), kind: 'log', ts: Date.now(), payload: { level, msg },
      })
    },
  }
}

function cancelAllPending(state: WorkerState, reason: string): void {
  for (const [, entry] of state.pending) {
    clearTimeout(entry.timer)
    entry.reject(new Error(reason))
  }
  state.pending.clear()
  for (const [, entry] of state.pendingChat) {
    clearTimeout(entry.timer)
    entry.reject(new Error(reason))
  }
  state.pendingChat.clear()
}

function resolvePending(map: Map<string, PendingEntry>, frame: Frame): void {
  const entry = map.get(frame.id)
  if (entry) { clearTimeout(entry.timer); map.delete(frame.id); entry.resolve(frame.payload) }
}

function rejectPending(map: Map<string, PendingEntry>, frame: Frame, prefix: string): void {
  const entry = map.get(frame.id)
  if (entry) {
    clearTimeout(entry.timer); map.delete(frame.id)
    const p = frame.payload as { code?: string; message?: string }
    entry.reject(new Error(`${prefix} error [${p.code ?? 'UNKNOWN'}]: ${p.message ?? 'no message'}`))
  }
}

function makeHandleData(
  state: WorkerState,
  decoder: FrameDecoder,
  handleInit: (frame: Frame) => Promise<void>,
): (chunk: Buffer) => void {
  return function handleData(chunk: Buffer): void {
    for (const frame of decoder.push(chunk)) {
      switch (frame.kind) {
        case 'init':
          if (!state.initialised) {
            handleInit(frame).catch(() => { /* caught inside handleInit */ })
          }
          break

        case 'invoke-resp':
          resolvePending(state.pending, frame)
          break

        case 'chat-resp':
          resolvePending(state.pendingChat, frame)
          break

        case 'chat-error':
          rejectPending(state.pendingChat, frame, 'chat')
          break

        case 'error': {
          const entry = state.pending.get(frame.id) ?? state.pendingChat.get(frame.id)
          if (entry) {
            clearTimeout(entry.timer)
            state.pending.delete(frame.id); state.pendingChat.delete(frame.id)
            const p = frame.payload as { code?: string; message?: string }
            entry.reject(new Error(`worker rpc error [${p.code ?? 'UNKNOWN'}]: ${p.message ?? 'no message'}`))
          }
          break
        }

        case 'shutdown': {
          const p = frame.payload as { reason?: string }
          cancelAllPending(state, `shutdown: ${p.reason ?? 'parent-requested'}`)
          state.exited = true
          setTimeout(() => process.exit(0), 100)
          break
        }

        // Parent should never send these, but be defensive.
        case 'invoke-req':
        case 'result':
        case 'log':
        case 'chat-req':
        case 'tool-call-req':
        case 'tool-call-resp':
        case 'progress':
          break
      }
    }
  }
}

/**
 * Run a job handler inside the spawn worker protocol.
 */
export async function runWorker(
  handler: (job: unknown, ctx: JobContext) => Promise<unknown>,
): Promise<void> {
  const decoder = new FrameDecoder()
  const state: WorkerState = {
    pending: new Map(), pendingChat: new Map(),
    initialised: false, exited: false,
    writeFrame: (f: Frame) => { process.stdout.write(encodeFrame(f)) },
  }

  const ctx = createWorkerContext(state)

  const handleInit = async (frame: Frame): Promise<void> => {
    state.initialised = true
    try {
      try {
        const payload = frame.payload as Record<string, unknown>
        const result = await handler(payload.job, ctx)
        if (state.exited) { process.exit(0); return }
        state.writeFrame({ v: 1, id: crypto.randomUUID(), kind: 'result', ts: Date.now(), payload: result })
        process.exit(0)
      } catch (err) {
        if (state.exited) { process.exit(1); return }
        state.writeFrame({
          v: 1, id: crypto.randomUUID(), kind: 'error', ts: Date.now(),
          payload: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) },
        })
        process.exit(1)
      }
    } finally {
      setTimeout(() => process.exit(1), 1000).unref()
    }
  }

  const handleData = makeHandleData(state, decoder, handleInit)

  if (process.stdin.isPaused()) {
    process.stdin.resume()
  }

  process.stdin.on('data', handleData)

  process.stdin.on('end', () => {
    cancelAllPending(state, 'parent stdin closed')
    state.exited = true
    setTimeout(() => process.exit(1), STDIN_EOF_EXIT_DELAY_MS)
  })
}
