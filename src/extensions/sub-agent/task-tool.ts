import type { Tool } from '../../application/ports/tool'
import type { ToolContext } from '../../application/ports/tool-context'
import type { SubAgentRunner } from './types'

interface TaskToolDeps {
  runSubAgent: SubAgentRunner
}

const TASK_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    subagent_type: {
      type: 'string',
      enum: ['explore', 'plan', 'general-purpose'],
      description: 'Type of sub-agent to invoke.',
    },
    description: {
      type: 'string',
      description: 'Short description of the sub-task (one sentence).',
    },
    prompt: {
      type: 'string',
      description: 'Full prompt for the sub-agent. Include all necessary context.',
    },
  },
  required: ['subagent_type', 'description', 'prompt'],
}

export function createTaskTool(deps: TaskToolDeps): Tool {
  return {
    name: 'task',
    description: 'Delegate a self-contained sub-task to a sub-agent. Use when context-isolated investigation or planning helps.',
    parameters: TASK_TOOL_SCHEMA,
    readonly: false,
    renderHint: 'widget' as const,

    parse(raw: Record<string, unknown>): Record<string, unknown> {
      const type = typeof raw.subagent_type === 'string' ? raw.subagent_type : ''
      const description = typeof raw.description === 'string' ? raw.description : ''
      const prompt = typeof raw.prompt === 'string' ? raw.prompt : ''
      if (!prompt.trim()) throw new Error('task prompt must not be empty')
      return { subagent_type: type, description, prompt }
    },

    async execute(ctx: ToolContext, params: Record<string, unknown>): Promise<unknown> {
      const result = await deps.runSubAgent({
        type: params.subagent_type as string,
        prompt: params.prompt as string,
        parentSessionId: ctx.sessionId,
        parentTurnId: ctx.turnId,
        parentCallId: ctx.callId,
        parentSignal: ctx.signal,
      })
      return result
    },

    conflictKey: (input: unknown) => {
      const type = (input as { subagent_type?: string }).subagent_type ?? 'unknown'
      return `subagent:${type}`
    },
  }
}
