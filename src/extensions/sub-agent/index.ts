import { defineExtension } from '../../kernel/define-extension'
import { asContractBus } from '../../application/event-bus/contract-bus'
import { SubAgentRegistry, registerBuiltins } from './registry'
import { createTaskTool } from './task-tool'
import { createSpawnerSubAgentRunner } from './runner-spawner'
import type { JobSpawner } from '../../application/ports/job-spawner'
import type { ToolCatalog } from '../../application/ports/tool-catalog'
import type { ProviderChat, ProviderInvoke } from '../../application/ports/provider'

/**
 * Sub-agent extension (M2).
 *
 * M2 scope:
 * - SubAgentRegistry with 3 builtin descriptors (explore/plan/general-purpose)
 * - task tool registered via tool-catalog with dynamic enum
 * - runSubAgent delegates to spawner-based SubAgentRunner (process isolation)
 */
export default () =>
  defineExtension({
    name: 'sub-agent',
    enforce: 'normal',
    dependsOn: ['tool-catalog', 'session', 'provider', 'infra-services'],

    apply(ctx) {
      const bus = asContractBus(ctx.bus)
      const registry = new SubAgentRegistry()
      registerBuiltins(registry)

      const spawner = ctx.extensions.get('infra-services.job-spawner') as JobSpawner
      const toolCatalog = ctx.extensions.get('tool-catalog.catalog') as ToolCatalog
      const provider = ctx.extensions.get('provider.llm') as ProviderChat & ProviderInvoke

      const runSubAgent = createSpawnerSubAgentRunner({
        spawner,
        registry,
        toolCatalog,
        bus,
        chatComplete: async (req) => {
          const resp = await provider.complete({
            messages: req.messages,
            tools: req.tools,
            maxTokens: req.maxTokens,
            signal: req.signal,
          })
          const hasToolCalls = resp.toolCalls && resp.toolCalls.length > 0
          return {
            content: resp.content,
            toolCalls: resp.toolCalls,
            finishReason: hasToolCalls ? 'tool_calls' as const : 'stop' as const,
            usage: resp.usage,
          }
        },
        logger: ctx.logger,
        agentDir: ctx.agentDir,
      })

      toolCatalog.register(createTaskTool({ runSubAgent, registry }))

      return {
        provide: { 'sub-agent.registry': () => registry },
        dispose: () => registry.clear(),
      }
    },
  })
