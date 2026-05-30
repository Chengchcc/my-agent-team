import { defineExtension } from '../../kernel/define-extension'
import { asContractBus } from '../../application/event-bus/contract-bus'
import { SubAgentRegistry, registerBuiltins } from './registry'
import { createTaskTool } from './task-tool'
import { createSpawnerSubAgentRunner } from './runner-spawner'
import { attachWidgetBridge } from './widget-bridge'
import type { SubAgentDescriptor } from './types'
import type { JobSpawner } from '../../application/ports/job-spawner'
import type { ToolCatalog } from '../../application/ports/tool-catalog'
import type { ProviderChat, ProviderInvoke } from '../../application/ports/provider'

function resolveModel(hint: SubAgentDescriptor['modelHint']): string | undefined {
  switch (hint) {
    case 'fast': return 'claude-haiku-4-5-20251001'
    case 'strong': case undefined: return undefined
  }
}

/**
 * Sub-agent extension (M3).
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
            purpose: req.purpose,
            messages: req.messages,
            tools: req.tools,
            maxTokens: req.maxTokens,
            model: req.model,
            signal: req.signal,
          })
          return {
            content: resp.content,
            toolCalls: resp.toolCalls,
            finishReason: resp.finishReason,
            usage: resp.usage,
          }
        },
        logger: ctx.logger,
        agentDir: ctx.agentDir,
        resolveModel,
      })

      toolCatalog.register(createTaskTool({ runSubAgent, registry }))

      const detachBridge = attachWidgetBridge(bus, ctx.logger)

      return {
        provide: {
          'sub-agent.registry': () => registry,
          'sub-agent.runner': () => runSubAgent,
        },
        dispose: () => {
          detachBridge()
          registry.clear()
        },
      }
    },
  })
