// TODO(lobster): as any casts — JsonRpcMessage discriminated union narrowing, needs proper type guard refactoring

import { createServer, createConnection } from 'node:net'
import { createInterface } from 'node:readline'
import type { Transport } from '../../application/ports/transport';
import type { JsonRpcMessage, JsonRpcResponse } from '../../application/contracts';
import type { DataPlaneEvent } from '../../application/contracts';

const RPC_TIMEOUT_MS = 30_000

function hasId(m: JsonRpcMessage): m is JsonRpcMessage & { id: string | number } {
  return typeof (m as { id?: unknown }).id !== 'undefined'
}
function hasMethod(m: JsonRpcMessage): m is JsonRpcMessage & { method: string } {
  return typeof (m as { method?: unknown }).method === 'string'
}

/**
 * Server side — listens on UnixSocket, accepts frontend connections.
 * Wraps the Kernel's transport for cross-process use.
 */
export interface UnixSocketServerHandle {
  close(): Promise<void>
}

function startUnixServer(socketPath: string, kernelTransport: Transport): Promise<UnixSocketServerHandle> {
  const sockets = new Set<ReturnType<typeof createConnection>>()

  const server = createServer((socket) => {
    sockets.add(socket)
    const rl = createInterface({ input: socket, crlfDelay: Infinity })

    // Forward incoming JSON-RPC from frontend → kernel transport
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- fire-and-forget event handler
    rl.on('line', async (line) => {
      try {
        const msg: JsonRpcMessage & { kind?: string } = JSON.parse(line)
        if (msg.kind === 'ping') {
          socket.write(JSON.stringify({ kind: 'pong' }) + '\n')
          return
        }
        const response = await kernelTransport.sendRpc(msg)
        if (response) socket.write(JSON.stringify(response) + '\n')
      } catch (_err) {
        socket.write(JSON.stringify({
          jsonrpc: '2.0', id: null,
          error: { code: -32700, message: 'Parse error' },
        }) + '\n')
      }
    })

    // Subscribe to kernel events → push to frontend
    const unsub = kernelTransport.onEvent((event) => {
      if (socket.writable) {
        const data = JSON.stringify({ kind: 'event', ev: event }) + '\n'
        socket.write(data)
      }
    })

    socket.on('close', () => { sockets.delete(socket); unsub(); rl.close() })
    socket.on('error', () => { sockets.delete(socket); unsub(); rl.close() })
  })

  return new Promise((resolve) => {
    server.listen(socketPath, () => resolve({
      close: async () => {
        for (const s of sockets) s.destroy()
        sockets.clear()
        return new Promise<void>((res) => server.close(() => res()))
      },
    }))
  })
}

/**
 * Client side — connects to daemon via UnixSocket.
 * Implements Transport so TUI/CLI can use the same interface.
 */
class UnixSocketTransport implements Transport {
  private socket: ReturnType<typeof createConnection> | null = null
  private eventHandlers = new Set<(event: DataPlaneEvent) => void>()
  private pendingRequests = new Map<string | number, {
    resolve: (r: JsonRpcResponse | null) => void
    reject: (e: Error) => void
  }>()
  private rl: ReturnType<typeof createInterface> | null = null
  private reqCounter = 0

  constructor(private socketPath: string) {}

  async connect(): Promise<void> {
    this.socket = createConnection(this.socketPath)
    this.rl = createInterface({ input: this.socket, crlfDelay: Infinity })

    return new Promise((resolve, reject) => {
      this.socket!.once('connect', () => {
        this.rl!.on('line', (line) => {
          try {
            const msg = JSON.parse(line) as JsonRpcResponse & { kind?: string | undefined; ev?: DataPlaneEvent }
            if (msg.kind === 'event' && msg.ev) {
              for (const h of this.eventHandlers) {
                try { h(msg.ev) } catch {}
              }
            } else if (msg.jsonrpc === '2.0' && msg.id !== undefined) {
              const pending = this.pendingRequests.get(msg.id!)
              if (pending) {
                this.pendingRequests.delete(msg.id!)
                pending.resolve(msg)
              }
            }
          } catch {}
        })
        resolve()
      })
      this.socket!.once('error', reject)
    })
  }

  async sendRpc(message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
    if (!this.socket) throw new Error('Not connected')
    const id = (hasId(message) ? String(message.id) : `req-${++this.reqCounter}`)
    const msg = { ...message, id }

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject })
      this.socket!.write(JSON.stringify(msg) + '\n')
      // Timeout after 30s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          reject(new Error(`RPC timeout: ${hasMethod(msg) ? msg.method : 'unknown'}`))
        }
      }, RPC_TIMEOUT_MS)
    })
  }

  onEvent(handler: (event: DataPlaneEvent) => void): () => void {
    this.eventHandlers.add(handler)
    return () => { this.eventHandlers.delete(handler) }
  }

  async close(): Promise<void> {
    this.rl?.close()
    this.socket?.destroy()
    this.socket = null
    this.rl = null
  }
}

export { startUnixServer, UnixSocketTransport }
