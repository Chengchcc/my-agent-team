/**
 * Worker-side runtime helper for the spawn LLM bridge.
 * Workers that want to participate in the stdio NDJSON RPC protocol
 * wrap their `handle()` call in `runWorker()` instead of hand-writing
 * the protocol.
 *
 * @worker-runtime
 * This module is statically imported by all worker entries.
 * MUST NOT execute side effects at top level (no process.stdin access,
 * no console.log, no connection setup). All runtime behavior must be
 * inside runWorker() or later.
 */

import { FrameDecoder, encodeFrame, type Frame } from './spawn-rpc/frame'
import type { JobContext } from '../../application/ports/job-spawner'
import { WorkerRpcError, type WorkerRpcCode } from './spawn-rpc/errors'

const WORKER_INVOKE_TIMEOUT_MS = 70_000
const WORKER_CHAT_TIMEOUT_MS = 70_000
const WORKER_TOOL_TIMEOUT_MS = 60_000
const STDIN_EOF_EXIT_DELAY_MS = 5_000

interface PendingEntry {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

interface WorkerState {
  pending: Map<string, PendingEntry>
  pendingChat: Map<string, PendingEntry>
  pendingTool: Map<string, PendingEntry>
  initialised: boolean
  exited: boolean
  fatal: WorkerRpcError | null
  writeFrame: (f: Frame) => void
}

function createWorkerContext(state: WorkerState): JobContext {
  return {
    invoke: (req) => {
      if (state.fatal) throw state.fatal
      return new Promise<{ content: string; usage: { input: number; output: number } }>(
        (resolve, reject) => {
          const id = crypto.randomUUID()
          const timer = setTimeout(() => {
            state.pending.delete(id)
            reject(new WorkerRpcError('TIMEOUT', 'worker invoke timeout', id))
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
      if (state.fatal) throw state.fatal
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID()
        const timer = setTimeout(() => {
          state.pendingChat.delete(id)
          reject(new WorkerRpcError('TIMEOUT', 'worker chatComplete timeout', id))
        }, WORKER_CHAT_TIMEOUT_MS)
        state.pendingChat.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject: reject as (e: unknown) => void,
          timer,
        })
        state.writeFrame({ v: 1, id, kind: 'chat-req', ts: Date.now(), payload: req })
      })
    },
    dispatchTool: (call) => {
      if (state.fatal) throw state.fatal
      return new Promise<{ success: boolean; result?: unknown; error?: { code: string; message: string } }>(
        (resolve, reject) => {
          const id = crypto.randomUUID()
          const timer = setTimeout(() => {
            state.pendingTool.delete(id)
            reject(new WorkerRpcError('TOOL_TIMEOUT', 'worker dispatchTool timeout', id))
          }, WORKER_TOOL_TIMEOUT_MS)
          state.pendingTool.set(id, {
            resolve: resolve as (v: unknown) => void,
            reject: reject as (e: unknown) => void,
            timer,
          })
          state.writeFrame({ v: 1, id, kind: 'tool-call-req', ts: Date.now(), payload: call })
        },
      )
    },
    log: (level, msg) => {
      state.writeFrame({
        v: 1, id: crypto.randomUUID(), kind: 'log', ts: Date.now(), payload: { level, msg },
      })
    },
  }
}

function cancelAllPending(state: WorkerState, reason: string): void {
  for (const m of [state.pending, state.pendingChat, state.pendingTool]) {
    for (const [, entry] of m) {
      clearTimeout(entry.timer)
      entry.reject(new WorkerRpcError('WORKER_FATAL', reason))
    }
    m.clear()
  }
}

function resolvePending(map: Map<string, PendingEntry>, frame: Frame): void {
  const entry = map.get(frame.id)
  if (entry) { clearTimeout(entry.timer); map.delete(frame.id); entry.resolve(frame.payload) }
}

function rejectPending(map: Map<string, PendingEntry>, frame: Frame, code: WorkerRpcCode): void {
  const entry = map.get(frame.id)
  if (entry) {
    clearTimeout(entry.timer)
    map.delete(frame.id)
    const p = frame.payload as { message?: string }
    entry.reject(new WorkerRpcError(code, p.message ?? 'no message', frame.id))
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

        case 'tool-call-resp':
          resolvePending(state.pendingTool, frame)
          break

        case 'chat-error':
          rejectPending(state.pendingChat, frame, 'PROVIDER_ERROR')
          break

        case 'error': {
          const p = frame.payload as { code?: WorkerRpcCode; message?: string }
          const code = p.code ?? 'UNKNOWN'
          const err = new WorkerRpcError(code, p.message ?? 'no message', frame.id)

          // Reject trigger entry only (invoke or chat — NOT tool)
          const entry = state.pending.get(frame.id) ?? state.pendingChat.get(frame.id)
          if (entry) { clearTimeout(entry.timer); entry.reject(err) }
          state.pending.delete(frame.id); state.pendingChat.delete(frame.id)

          // Reject ALL pending tool calls (they'll never get a response)
          for (const [id, tool] of state.pendingTool) {
            clearTimeout(tool.timer)
            tool.reject(new WorkerRpcError('WORKER_FATAL', `Worker entered fatal state: ${err.message}`, id))
          }
          state.pendingTool.clear()

          state.fatal = err
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
    pending: new Map(), pendingChat: new Map(), pendingTool: new Map(),
    initialised: false, exited: false, fatal: null,
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
