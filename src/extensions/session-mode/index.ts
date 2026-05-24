import { defineExtension } from '../../kernel/define-extension'
import type { HookHandler } from '../../kernel/define-extension'
import type { ToolDescriptor } from '../../domain/turn-runner.types'
import type { SessionStore } from '../../application/ports/session-store'
import type { ToolCatalog } from '../../application/ports/tool-catalog'
import { ModeRegistry, registerBuiltinModes } from './registry'

/**
 * Session-mode extension.
 *
 * M1 scope:
 * - ModeRegistry with builtin 'plan' descriptor
 * - transformPrompt (post): inject PLAN_MODE_PROMPT when mode is 'plan'
 * - resolveTools (post): filter to readonly + todo_write + exit_plan_mode
 * - onToolCall guard (pre): double insurance block on write/bash in plan mode
 */
export default () =>
  defineExtension({
    name: 'session-mode',
    enforce: 'post',
    dependsOn: ['session'],

    apply(ctx) {
      const registry = new ModeRegistry()
      registerBuiltinModes(registry)

      /** Read session mode from store. */
      async function getMode(sessionId: string): Promise<string> {
        const store = ctx.extensions.get<SessionStore>('session.store')
        const s = await store.load(sessionId)
        return s?.mode ?? 'normal'
      }

      // ── transformPrompt: inject mode prompt (post phase) ──

      const transformPrompt: HookHandler = async (...args: unknown[]) => {
        const input = args[0] as { system: string; messages: Array<{ role: string; content: string }>; sessionId?: string }
        const sid = input.sessionId
        if (!sid) return input
        const mode = await getMode(sid)
        const desc = registry.get(mode)
        if (!desc) return input
        return { ...input, system: `${input.system}\n\n${desc.systemPromptAppend}` }
      }

      // ── resolveTools: filter by mode's toolFilter (post phase) ──

      const resolveTools: HookHandler = async (...args: unknown[]) => {
        const tools = args[0] as ToolDescriptor[]
        const sessionId = args[1] as string | undefined
        if (!sessionId) return tools
        const mode = await getMode(sessionId)
        const desc = registry.get(mode)
        if (!desc) return tools
        return tools.filter(t => desc.toolFilter(t))
      }

      // ── onToolCall: guard (pre phase, double insurance) ──

      const onToolCall: HookHandler = async (...args: unknown[]) => {
        const call = args[0] as { name: string }
        const toolCtx = args[1] as { sessionId: string } | undefined
        const sid = toolCtx?.sessionId
        if (!sid) return call
        const mode = await getMode(sid)
        const desc = registry.get(mode)
        if (!desc) return call

        // Look up real tool metadata from catalog
        const catalog = ctx.extensions.get<ToolCatalog>('tool-catalog.catalog')
        const toolMeta = catalog?.get(call.name)
        const toolDesc: ToolDescriptor = {
          name: call.name,
          description: '',
          parameters: {},
          readonly: toolMeta?.readonly,
        }
        if (!desc.toolFilter(toolDesc)) {
          throw new Error(
            `Tool "${call.name}" is not allowed in "${mode}" mode. Switch to normal mode first.`,
          )
        }
        return call
      }

      return {
        provide: {
          registry: () => registry,
        },
        hooks: {
          transformPrompt: {
            enforce: 'post',
            fn: transformPrompt,
          },
          resolveTools: {
            enforce: 'post',
            fn: resolveTools,
          },
          onToolCall: {
            enforce: 'pre',
            order: 10,
            fn: onToolCall,
          },
        },
      }
    },
  })
