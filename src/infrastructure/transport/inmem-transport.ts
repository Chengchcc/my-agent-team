import type { Transport } from '../../application/ports/transport';
import type { JsonRpcMessage, JsonRpcResponse } from '../../application/contracts';
import type { DataPlaneEvent } from '../../application/contracts';
import type { KernelContext } from '../../kernel/kernel-context'

/**
 * ControlPlane server shape — the handle method we call for RPC routing.
 */
interface CpServer {
  handle: (message: JsonRpcMessage) => Promise<JsonRpcResponse | null>
}

/**
 * InMemoryTransport — single-process transport adapter that wraps the
 * ControlPlane JSON-RPC server and the DataPlane event bus.
 *
 * Used by in-process frontends (TUI, tests). For remote or cross-process
 * frontends, swap in StdioTransport or WebSocketTransport instead.
 */
class InMemoryTransport implements Transport {
  private cpServer: CpServer
  private eventHandlers = new Set<(event: DataPlaneEvent) => void>()
  private unsubscribeBus: (() => void) | null = null

  constructor(ctx: KernelContext) {
    // Cache the ControlPlane server handle — guaranteed to exist because
    // transport.inmem dependsOn ['controlplane', 'dataplane']
    this.cpServer = ctx.extensions.get<CpServer>('controlplane.server')

    // Subscribe to DataPlane events on bus, forward to handlers
    this.unsubscribeBus = ctx.bus.on('dataplane.event', (evt: unknown) => {
      for (const handler of this.eventHandlers) {
        try {
          handler(evt as DataPlaneEvent)
        } catch {
          // Isolation: one handler failing does not affect others
        }
      }
    })
  }

  async sendRpc(message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
    return this.cpServer.handle(message)
  }

  onEvent(handler: (event: DataPlaneEvent) => void): () => void {
    this.eventHandlers.add(handler)
    return () => {
      this.eventHandlers.delete(handler)
    }
  }

  async close(): Promise<void> {
    this.unsubscribeBus?.()
    this.unsubscribeBus = null
    this.eventHandlers.clear()
  }
}

export { InMemoryTransport }
