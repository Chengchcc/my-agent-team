import { defineExtension } from '../../kernel/define-extension'
import type { HookHandler } from '../../kernel/define-extension'
import { asContractBus } from '../../application/event-bus/contract-bus'
import { PermissionStore } from './store'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_INPUT_SIZE = 65536

interface PendingRequest {
  grant: () => void
  deny: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Permission extension — intercepts tool calls for security policy enforcement.
 *
 * Runs BEFORE tools extension (enforce: 'pre') to intercept tool calls.
 * Depends on session for per-session allowlist scoping.
 *
 * Capabilities exposed:
 *   - permission.checker: PermissionChecker (check, deny, allowOnce)
 *
 * Hooks:
 *   - onToolCall (pre): intercepts tool calls before tools extension executes.
 *     Throws for denied tools. For dangerous tools (bash, write), emits
 *     permission.required on the bus and blocks until the frontend calls
 *     permission.resolve RPC or the timeout expires (auto-deny).
 *
 * RPC methods:
 *   - permission.resolve: resolves permission requests from ControlPlane.
 *     Accepts { reqId, decision } for blocking popup resolution or
 *     { decision, sessionId, toolName } for session allowlist management.
 */
/* eslint-disable max-lines-per-function */
export default () =>
  defineExtension({
    name: 'permission',
    enforce: 'pre',
    dependsOn: ['session'],

    apply: (ctx) => {
      const contractBus = asContractBus(ctx.bus)
      const deniedTools = new Set<string>()
      const sessionAllowlists = new Map<string, Set<string>>()
      const pendingRequests = new Map<string, PendingRequest>()
      const store = new PermissionStore(ctx.paths.permissions)
      // Load global allowlist on startup (async, non-blocking)
      let globalAllowlist = new Set<string>()
      store.load().then(s => { globalAllowlist = s; }).catch(() => {})
      const timeoutMs: number = (ctx.config.raw.permissionTimeoutMs as number) ?? DEFAULT_TIMEOUT_MS

      // onToolCall handler: pre-intercept tool calls
      const onToolCall: HookHandler = async (...args: unknown[]) => {
        const call = args[0] as { name: string; id: string; arguments?: unknown }
        const runCtx = args[1] as { sessionId?: string; turnId?: string; environment?: { cwd?: string } } | undefined
        const sessionId = runCtx?.sessionId
        const turnId = runCtx?.turnId
        if (!sessionId) {
          throw new Error('permission: missing sessionId in ToolContext')
        }

        // Deny-list check
        if (deniedTools.has(call.name)) {
          throw new Error(`Tool "${call.name}" is denied by policy`)
        }

        // Per-session allowlist check
        const allowed = sessionAllowlists.get(sessionId)
        if (allowed && !allowed.has(call.name)) {
          throw new Error(
            `Tool "${call.name}" is not allowed in session "${sessionId}"`,
          )
        }

        // Global allowlist check (persisted always-allow)
        if (globalAllowlist.has(call.name)) return call;

        // For dangerous tools, wait for user permission
        const rawCfg = ctx.config.raw as Record<string, unknown> | undefined;
        const permCfg = rawCfg?.permission as Record<string, unknown> | undefined;
        const dangerousToolNames = (permCfg?.dangerousTools as string[] | undefined)
          ?? ['bash', 'edit', 'write'];
        const dangerousTools = new Set(dangerousToolNames);
        if (dangerousTools.has(call.name) || call.name.startsWith('mcp.')) {
          // eslint-disable-next-line @typescript-eslint/no-magic-numbers -- toString radix
          const reqId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

          // Create the pending promise before emitting — so the frontend
          // can resolve it in its bus listener immediately.
          const permissionPromise = new Promise<void>((_resolve, _reject) => {
            const timer = setTimeout(() => {
              pendingRequests.delete(reqId)
              _reject(
                new Error(
                  `Permission timeout: "${call.name}" approval not received within ${timeoutMs}ms`,
                ),
              )
            }, timeoutMs)

            pendingRequests.set(reqId, {
              grant: () => {
                clearTimeout(timer)
                _resolve()
              },
              deny: (err) => {
                clearTimeout(timer)
                _reject(err)
              },
              timer,
            })
          })

          const inputRaw = JSON.stringify(call.arguments ?? '');
          const truncated = inputRaw.length > MAX_INPUT_SIZE;
          await contractBus.emit('permission.required', {
            reqId,
            toolName: call.name,
            sessionId,
            input: truncated ? JSON.parse(inputRaw.slice(0, MAX_INPUT_SIZE)) as unknown : call.arguments,
            cwd: runCtx?.environment?.cwd ?? process.cwd(),
            inputTruncated: truncated || undefined,
          }, { sessionId, turnId })

          await permissionPromise
        }

        // Pass through call to next handler in chain (e.g. tools extension)
        return call
      }

      return {
        provide: {
          'permission.checker': () => ({
            check: (toolName: string, _sessionId?: string) => {
              if (deniedTools.has(toolName)) return false
              if (_sessionId) {
                const allowed = sessionAllowlists.get(_sessionId)
                if (allowed && !allowed.has(toolName)) return false
              }
              return true
            },
            deny: (toolName: string) => {
              deniedTools.add(toolName)
            },
            allowOnce: (sessionId: string, toolName: string) => {
              if (!sessionAllowlists.has(sessionId)) {
                sessionAllowlists.set(sessionId, new Set())
              }
              sessionAllowlists.get(sessionId)!.add(toolName)
            },
          }),
        },

        hooks: {
          onToolCall: {
            enforce: 'guard',
            fn: onToolCall,
          },
        },

        rpc: {
          'permission.resolve': (params: unknown) => {
            const p = params as {
              reqId?: string
              decision?: string
              sessionId?: string
              toolName?: string
            }

            // Resolve a specific pending request (blocking popup path)
            if (p?.reqId) {
              const pending = pendingRequests.get(p.reqId)
              if (pending) {
                pendingRequests.delete(p.reqId)
                if (p.decision === 'allow') {
                  pending.grant()
                } else if (p.decision === 'always') {
                  // Persist always-allow
                  if (p.toolName) {
                    globalAllowlist.add(p.toolName)
                    store.addAlways(p.toolName).catch(() => {})
                  }
                  pending.grant()
                } else {
                  pending.deny(
                    new Error(
                      `Permission denied by user for "${p.toolName ?? 'unknown'}"`,
                    ),
                  )
                }
              }
              return { ok: true }
            }

            // Session allowlist management (legacy path)
            if (
              p?.decision === 'allow' &&
              p?.sessionId &&
              p?.toolName
            ) {
              const allowed =
                sessionAllowlists.get(p.sessionId) ?? new Set()
              allowed.add(p.toolName)
              sessionAllowlists.set(p.sessionId, allowed)
            }
            return { ok: true }
          },

          'permission.list': async () => {
            const tools = await store.listAlways()
            return { tools }
          },

          'permission.remove': async (params: unknown) => {
            const p = params as { sessionId?: string; toolName?: string }
            if (!p.toolName) return { ok: false }
            const removed = await store.removeAlways(p.toolName)
            if (removed) globalAllowlist.delete(p.toolName)
            return { ok: removed }
          },
        },

        dispose: () => {
          // Reject all pending requests so no hooks hang on shutdown
          for (const [_reqId, pending] of pendingRequests) {
            clearTimeout(pending.timer)
            pending.deny(new Error('Permission extension disposed'))
          }
          pendingRequests.clear()
          deniedTools.clear()
          sessionAllowlists.clear()
        },
      }
    },
  })
