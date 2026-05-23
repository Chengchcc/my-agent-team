import path from 'node:path'
import fs from 'node:fs/promises'
import { defineExtension } from '../../kernel/define-extension'
import { startUnixServer } from '../../infrastructure/transport/unix-socket-transport'
import type { UnixSocketServerHandle } from '../../infrastructure/transport/unix-socket-transport'
import type { Transport } from '../../application/ports/transport'
import type { KernelContext } from '../../kernel/kernel-context'
import type { JsonRpcMessage, JsonRpcResponse } from '../../application/contracts';
import type { DataPlaneEvent } from '../../application/contracts';

function buildKernelTransport(ctx: KernelContext): Transport {
  const cpServer = ctx.extensions.get<{ handle: (m: JsonRpcMessage) => Promise<JsonRpcResponse | null> }>('controlplane.server')
  const handlers = new Set<(event: DataPlaneEvent) => void>()

  const unsub = ctx.bus.on('dataplane.event', (evt: unknown) => {
    for (const h of handlers) {
      try { h(evt as DataPlaneEvent) } catch {}
    }
  })

  return {
    sendRpc: (msg) => cpServer.handle(msg),
    onEvent: (handler) => {
      handlers.add(handler)
      return () => { handlers.delete(handler) }
    },
    close: async () => {
      unsub()
      handlers.clear()
    },
  }
}

export const transportUnix = (cfg: { socketPath: string }) =>
  defineExtension({
    name: 'transport-unix',
    enforce: 'post',
    dependsOn: ['controlplane', 'dataplane'],
    apply: (ctx) => {
      let server: UnixSocketServerHandle | null = null
      const socketPath = cfg.socketPath

      return {
        hooks: {
          kernelReady: {
            enforce: 'post',
            fn: async () => {
              await fs.mkdir(path.dirname(socketPath), { recursive: true })
              await fs.unlink(socketPath).catch(() => {})
              const kt = buildKernelTransport(ctx)
              server = await startUnixServer(socketPath, kt)
              await fs.writeFile(socketPath + '.pid', String(process.pid))
              ctx.logger.info('transport', `listening on ${socketPath}`)
            },
          },
          onShutdown: {
            enforce: 'pre',
            fn: async () => {
              await server?.close()
              await fs.unlink(socketPath).catch(() => {})
              await fs.unlink(socketPath + '.pid').catch(() => {})
              server = null
              ctx.logger.info('transport', `stopped ${socketPath}`)
            },
          },
        },
      }
    },
  })
