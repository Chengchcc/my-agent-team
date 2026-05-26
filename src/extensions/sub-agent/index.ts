import { defineExtension } from '../../kernel/define-extension'
import { generateULID } from '../../shared/ulid'
import { runTurnUsecase, buildRunTurnDeps } from '../../application/usecases/run-turn'
import type { SubAgentRunner, SubAgentRunInput } from './types'
import { SubAgentRegistry, registerBuiltins } from './registry'
import { createTaskTool } from './task-tool'

/** Structured error marker for sub-agent failures — XML-style for LLM recognition. */
function errorResult(tag: string, reason: string): string {
  return `<sub-agent-error type="${tag}" reason="${reason}" />`
}

/**
 * Sub-agent extension.
 *
 * M1 scope:
 * - SubAgentRegistry with 3 builtin descriptors (explore/plan/general-purpose)
 * - task tool registered via tool-catalog
 * - runSubAgent closure reaches back to runTurnUsecase (DI via import)
 */
export default () =>
  defineExtension({
    name: 'sub-agent',
    enforce: 'normal',
    dependsOn: ['tool-catalog', 'session'],

    apply(ctx) {
      const registry = new SubAgentRegistry()
      registerBuiltins(registry)

      const runSubAgent: SubAgentRunner = async (input: SubAgentRunInput): Promise<string> => {
        const desc = registry.get(input.type)
        if (!desc) return errorResult('unknown_subagent_type', `"${input.type}" is not a registered sub-agent type`)

        const subSessionId = `sub:${input.parentTurnId}:${generateULID()}`

        ctx.logger.info('sub-agent', `Starting sub-agent "${input.type}" (${subSessionId})`)
        void ctx.bus.emit('subagent.started', { parentTurnId: input.parentTurnId, parentSessionId: input.parentSessionId, type: input.type, subSessionId, callId: input.parentCallId, ts: Date.now() })

        try {
          const res = await runTurnUsecase(
            {
              sessionId: subSessionId,
              turnId: `${input.parentTurnId}#sub`,
              userInput: input.prompt,
              frontendId: 'sub-agent',
              kind: 'sub-agent',
              allowedToolNames: desc.allowedToolNames.filter(n => n !== 'task'),
              maxOutputTokens: desc.maxOutputTokens,
              compaction: 'disabled',
              abortSignal: input.parentSignal,
              initialMessages: [
                { kind: 'history.record' as const, version: 1 as const, sessionId: subSessionId, role: 'system' as const, content: desc.systemPrompt, ts: Date.now() },
                { kind: 'history.record' as const, version: 1 as const, sessionId: subSessionId, role: 'user' as const, content: input.prompt, ts: Date.now() },
              ],
            },
            buildRunTurnDeps(ctx),
          )

          ctx.logger.info('sub-agent', `Sub-agent "${input.type}" completed, via:subagent:${input.type} usage: ${res.usage.input}+${res.usage.output}`)
          void ctx.bus.emit('subagent.completed', { parentTurnId: input.parentTurnId, parentSessionId: input.parentSessionId, type: input.type, subSessionId, callId: input.parentCallId, ok: true, usage: res.usage, finalText: res.finalText ?? '', ts: Date.now() })
          return res.finalText ?? ''
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('AbortError') || msg.includes('abort')) {
            return errorResult('cancelled', msg)
          }
          ctx.logger.warn('sub-agent', `Sub-agent "${input.type}" failed: ${msg}`)
          return errorResult('failed', msg)
        } finally {
          const history = ctx.extensions.get('session.history')
          void history?.drop(subSessionId)
        }
      }

      const catalog = ctx.extensions.get('tool-catalog.catalog')
      catalog.register(createTaskTool({ runSubAgent }))

      return {
        provide: {
          'sub-agent.registry': () => registry,
        },
        dispose: () => {
          registry.clear()
        },
      }
    },
  })
