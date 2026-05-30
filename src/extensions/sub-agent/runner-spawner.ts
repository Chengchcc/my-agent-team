import type { SubAgentRunner, SubAgentRunInput } from './types'
import type { JobSpawner, ChatCompleteRequest, ChatCompleteResponse } from '../../application/ports/job-spawner'
import type { ToolCatalog } from '../../application/ports/tool-catalog'
import type { Logger } from '../../application/ports/logger'
import type { ContractBus } from '../../application/event-bus/contract-bus'
import type { SubAgentRegistry } from './registry'
import type { ToolContext, ToolCallSource } from '../../application/ports/tool-context'
import type { SubAgentErrorType } from '../../application/contracts/subagent-events'
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
  resolveModel?: (hint: 'fast' | 'strong' | undefined) => string | undefined
}

const MAX_CONCURRENT_SUBAGENTS_PER_TURN = 3
const DEFAULT_SUBAGENT_LIFETIME_MS = 120_000

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;')
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
  const concurrentByTurn = new Map<string, number>()

  function tryAcquire(turnId: string): boolean {
    const count = concurrentByTurn.get(turnId) ?? 0
    if (count >= MAX_CONCURRENT_SUBAGENTS_PER_TURN) return false
    concurrentByTurn.set(turnId, count + 1)
    return true
  }

  function release(turnId: string): void {
    const c = concurrentByTurn.get(turnId) ?? 1
    if (c <= 1) concurrentByTurn.delete(turnId)
    else concurrentByTurn.set(turnId, c - 1)
  }

  return async (input: SubAgentRunInput): Promise<string> => {
    const desc = deps.registry.get(input.type)
    if (!desc) {
      const available = deps.registry.list().map(d => d.type).join(', ')
      return `<sub-agent-error type="unknown_subagent_type" reason="${escapeXmlAttr(input.type)}" available="${escapeXmlAttr(available)}" />`
    }

    if (!tryAcquire(input.parentTurnId)) {
      deps.logger.warn('sub-agent', `concurrency cap reached for turn ${input.parentTurnId}`)
      return `<sub-agent-error type="busy" reason="too many concurrent sub-agents (max ${MAX_CONCURRENT_SUBAGENTS_PER_TURN})" />`
    }

    const subSessionId = `sub:${input.parentTurnId}:${generateULID()}`
    const subTurnId = `${input.parentTurnId}#sub-${input.parentCallId}`
    const startedAt = Date.now()
    const model = deps.resolveModel?.(desc.modelHint)

    // R-2: best-effort emit, no try/catch
    deps.bus.emit('subagent.started', {
      parentTurnId: input.parentTurnId,
      parentSessionId: input.parentSessionId,
      subSessionId,
      type: input.type,
      description: input.description,
      callId: input.parentCallId,
      ts: startedAt,
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
          chatComplete: async (req) => deps.chatComplete({ ...req, model: req.model ?? model, signal: input.parentSignal }),
          dispatchTool: async (call) => {
            // S-2 gate: reject nested task tool
            if (call.name === 'task') {
              return { success: false, error: { code: 'TOOL_NOT_ALLOWED' as const, message: 'sub-agent cannot dispatch task tool (no nested sub-agents)' } }
            }
            if (!desc.allowedToolNames.includes(call.name)) {
              return { success: false, error: { code: 'TOOL_NOT_ALLOWED' as const, message: `tool "${call.name}" not in allowedToolNames` } }
            }
            const tool = deps.toolCatalog.get(call.name)
            if (!tool) {
              return { success: false, error: { code: 'TOOL_NOT_FOUND' as const, message: `tool "${call.name}" not found` } }
            }
            try {
              const source: ToolCallSource = {
                kind: 'subagent',
                subAgentType: input.type,
                subAgentCallId: input.parentCallId,
                parentSessionId: input.parentSessionId,
                parentTurnId: input.parentTurnId,
              }
              const tctx: ToolContext = {
                signal: input.parentSignal,
                environment: { cwd: deps.agentDir },
                sink: createToolSink() as unknown as ToolContext['sink'],
                sessionId: subSessionId,
                turnId: subTurnId,
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
          onProgress: (payload) => {
            if ((payload as { kind?: string }).kind !== 'sub-agent.inner-tool') return
            const p = payload as { kind: 'sub-agent.inner-tool'; innerCallId: string; toolName: string; phase: 'start' | 'end'; ok?: boolean; durationMs?: number }
            deps.bus.emit('subagent.progress', {
              parentTurnId: input.parentTurnId,
              parentSessionId: input.parentSessionId,
              subSessionId,
              callId: input.parentCallId,
              innerCallId: p.innerCallId,
              toolName: p.toolName,
              phase: p.phase,
              ok: p.ok,
              durationMs: p.durationMs,
              ts: Date.now(),
            })
          },
        },
        timeoutMs: desc.lifetimeMs ?? DEFAULT_SUBAGENT_LIFETIME_MS,
      })

      const typed = result as unknown as { usage: { input: number; output: number }; finalText: string; finishReason: string }
      deps.bus.emit('subagent.completed', {
        parentTurnId: input.parentTurnId,
        parentSessionId: input.parentSessionId,
        subSessionId,
        type: input.type,
        callId: input.parentCallId,
        ok: true,
        usage: typed.usage,
        finalText: typed.finalText,
        finishReason: typed.finishReason,
        durationMs: Date.now() - startedAt,
        ts: Date.now(),
      })
      return typed.finalText
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isAbort = err instanceof Error && err.name === 'AbortError'
      const tag = isAbort ? 'cancelled' : 'failed'
      deps.logger.warn('sub-agent', `worker ${tag} [${input.type}]: ${msg}`)

      const errorType: SubAgentErrorType = isAbort ? 'cancelled' : 'failed'

      deps.bus.emit('subagent.completed', {
        parentTurnId: input.parentTurnId,
        parentSessionId: input.parentSessionId,
        subSessionId,
        type: input.type,
        callId: input.parentCallId,
        ok: false,
        usage: { input: 0, output: 0 },
        errorType,
        errorMessage: msg,
        durationMs: Date.now() - startedAt,
        ts: Date.now(),
      })
      return `<sub-agent-error type="${tag}" reason="${escapeXmlAttr(msg)}" />`
    } finally {
      release(input.parentTurnId)
    }
  }
}
