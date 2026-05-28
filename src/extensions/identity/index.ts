import { defineExtension } from '../../kernel/define-extension'
import type { HookHandler } from '../../kernel/define-extension'
import { asContractBus } from '../../application/event-bus/contract-bus'
import { FileBackedIdentityStore } from '../../infrastructure/identity/file-backed-identity-store'
import { atomicRead } from '../../shared/atomic-write'
import { parseIdentityMarkdown } from '../../domain/identity-doc'
import { createBootstrapLoop } from './bootstrap-loop'
import type { AgentStore } from '../../application/ports/agent-store'

/**
 * Identity extension — provides identity versioning, prompt injection,
 * and memory recall integration.
 *
 * Capabilities exposed:
 *   - identity.store: FileBackedIdentityStore (current, update, getVersion,
 *     getHistory, rollback)
 *
 * Hooks:
 *   - transformPrompt (pre): injects identity + retrieved memories into
 *     system prompt. Calls memory.recall to fetch relevant memories.
 *     Waits for hydration from identity.md before injecting.
 *     Runs BEFORE memory (enforce: 'pre' vs memory's 'normal').
 *   - onIdentityChanged (post): emits identity.changed bus event
 *
 * RPC methods for ControlPlane:
 *   - identity.get: returns current identity
 *   - identity.set: updates identity, emits identity.changed
 *   - identity.history: returns full diff history
 *   - identity.rollback: rolls back to a target version, emits identity.changed
 */
/** Shared bootstrap-loop factory to keep apply() under 150 lines. */
function getBootstrapLoop(ctx: Parameters<Parameters<typeof defineExtension>[0]['apply']>[0], store: FileBackedIdentityStore) {
  const provider = ctx.extensions.get('provider.llm')
  const registry = ctx.extensions.get('agent.registry')
  const agentStore = ctx.extensions.get('agent.store') as AgentStore | undefined
  if (!provider || !registry || !agentStore) return null
  return createBootstrapLoop({
    store,
    registry,
    provider,
    logger: ctx.logger,
    bootstrapPath: ctx.paths.identity.bootstrap,
    archivedPath: ctx.paths.identity.archived,
    agentStore,
    agentId: ctx.agentId,
  })
}

export default () =>
  defineExtension({
    name: 'identity',
    enforce: 'normal',

    apply: (ctx) => {
      const contractBus = asContractBus(ctx.bus)
      const store = new FileBackedIdentityStore(ctx.agentId, ctx.paths.identity.file)

      // Hydration initiator — no IO in apply (INV-Kernel-3).
      // IO happens in kernelReady hook; transformPrompt awaits store.hydrationDone.
      const hydrateStore = async () => {
        try {
          const content = await atomicRead(ctx.paths.identity.file, '')
          if (content && typeof content === 'string' && content.trim().length > 0) {
            const parsed = parseIdentityMarkdown(content)
            store.hydrate(parsed.frontMatter, parsed.body, 'file')
          } else {
            store.hydrate(
              { role: 'AI assistant', style: 'helpful, concise' },
              '',
              'bootstrap',
            )
          }
        } catch {
          store.hydrate(
            { role: 'AI assistant', style: 'helpful, concise' },
            '',
            'bootstrap',
          )
        }
      }

      // transformPrompt handler: inject identity + retrieved memories into system prompt
      const transformPrompt: HookHandler = async (...args: unknown[]) => {
        await store.hydrationDone
        const prompt = args[0] as {
          system: string
          messages: Array<{ role: string; content: string }>
        }

        // Check identity status from registry
        let status = 'ready'
        try {
          const registry = ctx.extensions.get('agent.registry')
          if (registry) {
            try {
              const rec = await registry.current()
              status = rec.identityStatus
            } catch { /* registry.current() may fail if DB not available */ }
          }
        } catch { /* registry may not be available in tests */ }

        if (status === 'pending_bootstrap') {
          const bootstrap = getBootstrapLoop(ctx, store)
          if (!bootstrap) return prompt
          return bootstrap.buildBootstrapSupplement(prompt, 'full')
        }

        // Inject identity
        const snapshot = store.current()
        const fieldLines = Object.entries(snapshot.fields)
          .filter(([k]) => k !== '__body')
          .map(([k, v]) => `- ${k}: ${v}`)
          .join('\n')
        prompt.system = `${prompt.system}\n\n<identity>\n${fieldLines}\n</identity>`
        if (snapshot.body) {
          prompt.system = `${prompt.system}\n\n<identity_full>\n${snapshot.body}\n</identity_full>`
        }

        // Inject retrieved memories via memory.recall
        try {
          const recall = ctx.extensions.get('memory.recall')
          if (recall) {
            const lastUserMsg = [...prompt.messages].reverse().find(m => m.role === 'user')
            if (lastUserMsg?.content) {
              const memories = await recall.search(lastUserMsg.content, { limit: 5 })
              if (memories.length > 0) {
                const formatted = memories
                  .map(m => `- [${m.type}] ${m.text}`)
                  .join('\n')
                prompt.system = `${prompt.system}\n\n<retrieved_memory>\n${formatted}\n</retrieved_memory>`
              }
            }
          }
        } catch (_err) {
          // memory.recall is best-effort; degrade gracefully
        }

        return prompt
      }

      // onIdentityChanged handler: notify when identity updates
      const onIdentityChanged: HookHandler = async (...args: unknown[]) => {
        void contractBus.emit('identity.changed', (args[0] ?? {}) as Record<string, unknown>)
      }

      // onTurnEnd handler: bootstrap-loop progress collection (M3 deferred identity)
      const onTurnEnd: HookHandler = async (...args: unknown[]) => {
        const bootstrap = getBootstrapLoop(ctx, store)
        if (!bootstrap) return
        const payload = args[0] as { userMessage?: { role: string; content: string } } | undefined
        await bootstrap.handleTurnEnd(payload ?? {})
      }

      return {
        provide: {
          'identity.store': () => store, // accessed as 'identity.store'
        },

        hooks: {
          kernelReady: {
            enforce: 'normal',
            fn: hydrateStore,
          },
          transformPrompt: {
            enforce: 'post',
            order: 1000,   // after session-mode (order 0), last hook to write system
            fn: transformPrompt,
          },
          onIdentityChanged: {
            enforce: 'post',
            fn: onIdentityChanged,
          },
          onTurnEnd: {
            enforce: 'post',
            fn: onTurnEnd,
          },
        },

        // RPC methods for ControlPlane
        rpc: {
          'identity.get': () => ({ identity: store.current() }),

          'identity.set': async (patch: unknown) => {
            const p = patch as { changes?: Record<string, unknown> }
            const fields: Record<string, string> = {}
            if (p.changes) {
              for (const [k, v] of Object.entries(p.changes)) {
                if (typeof v === 'string') fields[k] = v
              }
            }
            const diff = await store.update({ fields }, { source: 'rpc' })
            void contractBus.emit('identity.changed', diff as unknown as Record<string, unknown>)
            return { effectiveFrom: 'next-turn' }
          },

          'identity.history': () => ({ history: store.getHistory() }),

          'identity.rollback': async (params: unknown) => {
            const p = params as { targetVersion?: number }
            if (typeof p?.targetVersion !== 'number') {
              return { error: 'targetVersion is required and must be a number' }
            }
            try {
              const diff = await store.rollback(p.targetVersion, { source: 'rpc' })
              void contractBus.emit('identity.changed', diff as unknown as Record<string, unknown>)
              return {
                effectiveFrom: 'next-turn',
                version: store.getVersion(),
              }
            } catch (err) {
              return { error: (err as Error).message }
            }
          },
        },

        dispose: () => store.dispose(),
      }
    },
  })
