import type { SubAgentRunner, SubAgentRunInput } from './types'
import type { JobSpawner, ChatCompleteRequest, ChatCompleteResponse } from '../../application/ports/job-spawner'
import type { ToolCatalog } from '../../application/ports/tool-catalog'
import type { Logger } from '../../application/ports/logger'
import type { ContractBus } from '../../application/event-bus/contract-bus'
import type { SubAgentRegistry } from './registry'
import type { ToolContext, ToolCallSource } from '../../application/ports/tool-context'
import { generateULID } from '../../shared/ulid'
import { createToolSink } from '../../application/dispatch'

export interface SpawnerRunnerDeps {
  spawner: JobSpawner
  registry: SubAgentRegistry
  toolCatalog: ToolCatalog
  chatComplete: (req: ChatCompleteRequest) => Promise<ChatCompleteResponse>
  bus: ContractBus
  logger: Logger
  agentDir: string
}

const MAX_CONCURRENT_SUBAGENTS_PER_TURN = 3
const concurrentByTurn = new Map<string, number>()

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildToolSchemas(catalog: ToolCatalog, desc: { allowedToolNames: readonly string[] }) {
  return desc.allowedToolNames
    .filter(n => n !== 'task')
    .map(name => {
      const t = catalog.get(name)
      return t ? { name: t.name, description: t.description, parameters: t.parameters as Record<string, unknown> } : null
    })
    .filter(Boolean) as Array<{ name: string; description: string; parameters: Record<string, unknown> }>
}

export function createSpawnerSubAgentRunner(deps: SpawnerRunnerDeps): SubAgentRunner {
  return async (input: SubAgentRunInput): Promise<string> => {
    const desc = deps.registry.get(input.type)
    if (!desc) {
      const available = deps.registry.list().map(d => d.type).join(', ')
      return `<sub-agent-error type="unknown_subagent_type" reason="${escapeXmlAttr(input.type)}" available="${escapeXmlAttr(available)}" />`
    }

    const count = concurrentByTurn.get(input.parentTurnId) ?? 0
    if (count >= MAX_CONCURRENT_SUBAGENTS_PER_TURN) {
      deps.logger.warn('sub-agent', `concurrency cap reached for turn ${input.parentTurnId}`)
      return `<sub-agent-error type="busy" reason="too many concurrent sub-agents (max ${MAX_CONCURRENT_SUBAGENTS_PER_TURN})" />`
    }
    concurrentByTurn.set(input.parentTurnId, count + 1)

    const subSessionId = `sub:${input.parentTurnId}:${generateULID()}`
    const subTurnId = `${input.parentTurnId}#sub-${input.parentCallId}`

    void deps.bus.emit('subagent.started', {
      parentTurnId: input.parentTurnId, parentSessionId: input.parentSessionId,
      type: input.type, subSessionId, callId: input.parentCallId, ts: Date.now(),
    })

    try {
      const result = await deps.spawner.run({
        entry: require.resolve('./worker-entry-subagent'),
        job: {
          descriptor: desc,
          userPrompt: input.prompt,
          subSessionId,
          subTurnId,
          parentTurnId: input.parentTurnId,
          agentDir: deps.agentDir,
          toolSchemas: buildToolSchemas(deps.toolCatalog, desc),
        },
        ctx: {
          invoke: async () => {
            return { content: '', usage: { input: 0, output: 0 } }
          },
          chatComplete: async (req) => deps.chatComplete({ ...req, signal: input.parentSignal }),
          dispatchTool: async (call) => {
            if (!desc.allowedToolNames.includes(call.name)) {
              return { success: false, error: { code: 'TOOL_NOT_ALLOWED' as const, message: `tool "${call.name}" not in allowedToolNames` } }
            }
            const tool = deps.toolCatalog.get(call.name)
            if (!tool) {
              return { success: false, error: { code: 'TOOL_NOT_FOUND' as const, message: `tool "${call.name}" not found` } }
            }
            try {
              const source: ToolCallSource = { kind: 'subagent', subAgentType: input.type, subAgentCallId: input.parentCallId }
              const tctx: ToolContext = {
                signal: input.parentSignal,
                environment: { cwd: deps.agentDir },
                sink: createToolSink() as any,
                sessionId: input.parentSessionId,
                turnId: input.parentTurnId,
                callId: call.callId,
                source,
              }
              const execResult = await tool.execute(tctx, tool.parse ? tool.parse(call.arguments) : call.arguments)
              return { success: true, result: execResult }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              return { success: false, error: { code: 'TOOL_EXEC_FAIL' as const, message: msg } }
            }
          },
          log: (level, msg) => deps.logger[level]('sub-agent.worker', msg),
        },
        timeoutMs: desc.lifetimeMs ?? 120_000,
      })

      void deps.bus.emit('subagent.completed', {
        parentTurnId: input.parentTurnId, type: input.type, subSessionId,
        callId: input.parentCallId, ok: true,
        usage: (result as any).usage, finalText: (result as any).finalText,
        finishReason: (result as any).finishReason, ts: Date.now(),
      })
      return (result as any).finalText
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const tag = (err instanceof Error && err.name === 'AbortError') ? 'cancelled' : 'failed'
      deps.logger.warn('sub-agent', `worker ${tag} [${input.type}]: ${msg}`)
      return `<sub-agent-error type="${tag}" reason="${escapeXmlAttr(msg)}" />`
    } finally {
      const c = concurrentByTurn.get(input.parentTurnId) ?? 1
      if (c <= 1) {
        concurrentByTurn.delete(input.parentTurnId)
      } else {
        concurrentByTurn.set(input.parentTurnId, c - 1)
      }
    }
  }
}
