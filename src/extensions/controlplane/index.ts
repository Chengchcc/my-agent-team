import { defineExtension } from '../../kernel/define-extension'
import {
  isRequest,
  isNotification,
  buildSuccess,
  buildError,
  JSONRPC_ERRORS,
} from '../../application/contracts'
import type { JsonRpcMessage, JsonRpcResponse } from '../../application/contracts'

const PARAMS_PREVIEW_CHARS = 200

/**
 * ControlPlane extension — JSON-RPC 2.0 server for frontends.
 *
 * Runs LAST (enforce: 'post') so that all extensions register their RPC
 * methods before the ControlPlane's serve handler activates.
 *
 * Capabilities exposed:
 *   - controlplane.server: RPC server (handle, attachFrontend, detachFrontend, getFrontendSessions)
 *
 * Hooks:
 *   - kernelReady (normal): logs ready
 *   - onShutdown (pre): clears frontend session tracking
 */
export default () =>
  defineExtension({
    name: 'controlplane',
    enforce: 'post',
    apply: (ctx) => {
      const frontendSessions = new Map<string, Set<string>>() // frontendId -> sessionIds

      const server = {
            /**
             * Handle an incoming JSON-RPC message.
             * Routes to serveControlMethod hook (first-match).
             */
            async handle(
              message: JsonRpcMessage,
            ): Promise<JsonRpcResponse | null> {
              const t0 = Date.now()
              if (!isRequest(message)) {
                ctx.logger.warn('rpc', `INVALID request (${Date.now() - t0}ms)`)
                return buildError(null, JSONRPC_ERRORS.INVALID_REQUEST)
              }

              try {
                const isNotif = isNotification(message)
                const method = message.method ?? 'unknown'
                const pStr = JSON.stringify(message.params ?? {}).slice(0, PARAMS_PREVIEW_CHARS)

                ctx.logger.info('rpc', `← ${method} ${pStr}`)
                const handler = ctx.rpc.resolve(method)
                const result = handler
                  ? await handler(message.params ?? {})
                  : undefined

                if (result === undefined || result === null) {
                  ctx.logger.warn('rpc', `→ ${method} NOT_FOUND (${Date.now() - t0}ms)`)
                  if (isNotif) return null
                  return buildError(message.id ?? null, JSONRPC_ERRORS.METHOD_NOT_FOUND)
                }

                if (isNotif) return null
                ctx.logger.info('rpc', `→ ${method} ok (${Date.now() - t0}ms)`)
                return buildSuccess(message.id ?? null, result)
              } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err))
                ctx.logger.error('rpc', `→ ${message.method} ERROR: ${error.message}`)
                return buildError(
                  message.id ?? null,
                  { code: JSONRPC_ERRORS.INTERNAL_ERROR.code, message: error.message },
                  { message: error.message, stack: error.stack },
                )
              }
            },

            /** Track frontend attachment to a session */
            attachFrontend(frontendId: string, sessionId: string): void {
              if (!frontendSessions.has(frontendId)) {
                frontendSessions.set(frontendId, new Set())
              }
              frontendSessions.get(frontendId)!.add(sessionId)
              void ctx.bus.emit('frontend.attached', { frontendId, sessionId })
            },

            detachFrontend(frontendId: string, sessionId: string): void {
              frontendSessions.get(frontendId)?.delete(sessionId)
              void ctx.bus.emit('frontend.detached', { frontendId, sessionId })
            },

            getFrontendSessions(frontendId: string): string[] {
              return [...(frontendSessions.get(frontendId) ?? [])]
            },
          }

      return {
        provide: {
          'controlplane.server': () => server,
        },

        hooks: {
          kernelReady: {
            enforce: 'normal',
            fn: async () => {
              ctx.logger.info('controlplane', 'ControlPlane ready')
            },
          },
          onShutdown: {
            enforce: 'pre',
            fn: async () => {
              frontendSessions.clear()
            },
          },
        },

        rpc: {
          hello: () => {
            let model = ''
            try {
              const p = ctx.extensions.get('provider.llm') as { model?: string } | undefined
              if (p?.model) model = p.model
            } catch { /* provider may not be registered */ }
            return {
              server: 'my-agent',
              daemonVersion: '2.0.0',
              agentId: ctx.agentId,
              model,
              capabilities: {
                events: 25, // Keep in sync with DataPlaneEventType union
                methods: ctx.rpc.listMethods().length,
              },
              ts: Date.now(),
            }
          },
        },

        dispose: () => frontendSessions.clear(),
      }
    },
  })
