import { defineExtension } from '../../kernel/define-extension'
import type { HookHandler } from '../../kernel/define-extension'
import type { ToolDescriptor } from '../../domain/turn-runner.types'
import type { SessionStore } from '../../application/ports/session-store'
import type { ToolCatalog } from '../../application/ports/tool-catalog'
import type { SlashCommand, SlashContext, SlashResolution } from '../../application/slash'
import { defineTool } from '../../application/tool-factory/define-tool'
import { ModeRegistry, registerBuiltinModes } from './registry'

/**
 * Session-mode extension.
 *
 * M1: Session.mode field, ModeRegistry, plan hooks (transformPrompt, resolveTools, onToolCall)
 * M2: exit_plan_mode tool, setMode/getMode/resolvePlan RPC, /mode /plan /exit-plan slash
 */
export default () =>
  defineExtension({
    name: 'session-mode',
    enforce: 'post',
    dependsOn: ['session'],

    apply: createApply,
  })

function buildSlashCommands(
  registry: ModeRegistry,
  setMode: (sid: string, mode: string) => Promise<{ ok: boolean; error?: string }>,
): SlashCommand[] {
  return [
    {
      name: 'mode',
      description: 'Switch session mode (e.g. /mode plan, /mode normal)',
      source: 'builtin' as const, group: 'core',
      async resolve(input: string, slashCtx: SlashContext): Promise<SlashResolution> {
        const argv = input.trim().split(/\s+/)
        const modeName = argv[1]
        if (!modeName) {
          const modes = registry.list().map(d => d.name).join(', ')
          return { kind: 'handled', message: `Available modes: ${modes}` }
        }
        const result = await setMode(slashCtx.sessionId, modeName)
        if (!result.ok) return { kind: 'handled', message: result.error ?? 'Failed to switch mode' }
        return { kind: 'handled', message: `Mode switched to "${modeName}".` }
      },
    },
    {
      name: 'plan',
      description: 'Enter plan mode (alias for /mode plan)',
      source: 'builtin' as const, aliases: [], group: 'core',
      async resolve(_input: string, slashCtx: SlashContext): Promise<SlashResolution> {
        const result = await setMode(slashCtx.sessionId, 'plan')
        if (!result.ok) return { kind: 'handled', message: result.error ?? 'Failed' }
        return { kind: 'handled', message: 'Entered plan mode. Use /mode normal or /exit-plan to leave.' }
      },
    },
    {
      name: 'exit-plan',
      description: 'Exit plan mode (alias for /mode normal)',
      source: 'builtin' as const, aliases: [], group: 'core',
      async resolve(_input: string, slashCtx: SlashContext): Promise<SlashResolution> {
        const result = await setMode(slashCtx.sessionId, 'normal')
        if (!result.ok) return { kind: 'handled', message: result.error ?? 'Failed' }
        return { kind: 'handled', message: 'Exited plan mode. Full tool set restored.' }
      },
    },
  ]
}

function createApply(ctx: Parameters<Parameters<typeof defineExtension>[0]['apply']>[0]) {
      const registry = new ModeRegistry()
      registerBuiltinModes(registry)

      async function getMode(sessionId: string): Promise<string> {
        const store = ctx.extensions.get<SessionStore>('session.store')
        const s = await store.load(sessionId)
        return s?.mode ?? 'normal'
      }

      async function setMode(sessionId: string, mode: string): Promise<{ ok: boolean; error?: string }> {
        if (mode !== 'normal' && !registry.get(mode)) {
          return { ok: false, error: `Unknown mode: "${mode}"` }
        }
        const store = ctx.extensions.get<SessionStore>('session.store')
        const s = await store.load(sessionId)
        if (!s) return { ok: false, error: `Session "${sessionId}" not found` }
        const from = s.mode
        s.mode = mode
        await store.save(s)
        ctx.logger.info('session-mode', `Mode changed: ${from} → ${mode} (session ${sessionId})`)
        return { ok: true }
      }

      function buildHooks(): Record<string, { enforce: 'pre' | 'normal' | 'post'; order?: number; fn: HookHandler }> {
        const transformPrompt: HookHandler = async (...args: unknown[]) => {
          const input = args[0] as { system: string; messages: Array<{ role: string; content: string }>; sessionId?: string }
          const sid = input.sessionId
          if (!sid) return input
          const mode = await getMode(sid)
          const desc = registry.get(mode)
          if (!desc) return input
          return { ...input, system: `${input.system}\n\n${desc.systemPromptAppend}` }
        }

        const resolveTools: HookHandler = async (...args: unknown[]) => {
          const tools = args[0] as ToolDescriptor[]
          const sessionId = args[1] as string | undefined
          if (!sessionId) return tools
          const mode = await getMode(sessionId)
          const desc = registry.get(mode)
          if (!desc) return tools
          return tools.filter(t => desc.toolFilter(t))
        }

        const onToolCall: HookHandler = async (...args: unknown[]) => {
          const call = args[0] as { name: string }
          const toolCtx = args[1] as { sessionId: string } | undefined
          const sid = toolCtx?.sessionId
          if (!sid) return call
          const mode = await getMode(sid)
          const desc = registry.get(mode)
          if (!desc) return call
          const catalog = ctx.extensions.get<ToolCatalog>('tool-catalog.catalog')
          const toolMeta = catalog?.get(call.name)
          const toolDesc: ToolDescriptor = { name: call.name, description: '', parameters: {}, readonly: toolMeta?.readonly }
          if (!desc.toolFilter(toolDesc)) {
            throw new Error(`Tool "${call.name}" is not allowed in "${mode}" mode.`)
          }
          return call
        }

        return {
          transformPrompt: { enforce: 'post', fn: transformPrompt },
          resolveTools: { enforce: 'post', fn: resolveTools },
          onToolCall: { enforce: 'pre', order: 10, fn: onToolCall },
        }
      }

      // ── M2: exit_plan_mode tool ──

      function registerExitPlanTool(): void {
        const catalog = ctx.extensions.get<ToolCatalog>('tool-catalog.catalog')
        if (!catalog || catalog.get('exit_plan_mode')) return

        catalog.register(defineTool({
          name: 'exit_plan_mode',
          description: 'Submit the final plan for user approval. Call only when the plan is fully formed.',
          parameters: { type: 'object', properties: { plan: { type: 'string', description: 'The final implementation plan in markdown format.' } }, required: ['plan'] },
          parse(raw: Record<string, unknown>): Record<string, unknown> {
            const plan = typeof raw.plan === 'string' ? raw.plan : ''
            if (!plan.trim()) throw new Error('Plan must not be empty')
            return { plan }
          },
          async execute(toolCtx, params) {
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            ctx.bus.emit('session.planProposed', {
              sessionId: toolCtx.sessionId,
              planMd: (params as Record<string, unknown>).plan as string ?? '',
              ts: Date.now(),
            })
            return 'Plan submitted. Awaiting user decision.'
          },
          readonly: true,
          conflictKey: () => 'mode:global',
        }))
      }
      registerExitPlanTool()

      function buildRpc(): Record<string, (...args: unknown[]) => unknown | Promise<unknown>> {
        return {
          'session.setMode': (params: unknown) => {
            const p = params as { sessionId: string; mode: string }
            return setMode(p.sessionId, p.mode)
          },
          'session.getMode': async (params: unknown) => {
            const p = params as { sessionId: string }
            const mode = await getMode(p.sessionId)
            return { sessionId: p.sessionId, mode }
          },
          'session.resolvePlan': async (params: unknown) => {
            const p = params as { sessionId: string; decision: 'approve' | 'reject' | 'keep' }
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            ctx.bus.emit('session.planResolved', { sessionId: p.sessionId, decision: p.decision, ts: Date.now() })
            if (p.decision === 'approve') await setMode(p.sessionId, 'normal')
            return { ok: true, decision: p.decision }
          },
        }
      }

      return {
        provide: { registry: () => registry },
        hooks: buildHooks(),
        rpc: buildRpc(),
        slash: buildSlashCommands(registry, setMode),
      }
    }
