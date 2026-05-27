import type { ToolContext } from '../../../src/application/ports/tool-context'

export interface FakeToolSpec {
  name: string
  description?: string
  handler: (args: Record<string, unknown>, ctx: ToolContext) => unknown | Promise<unknown>
  delayMs?: number
}

/**
 * Build a Tool-compatible object that can be registered into tool-catalog.
 * The tool returns the handler result directly; throw to simulate failure.
 */
export function makeFakeTool(spec: FakeToolSpec) {
  return {
    name: spec.name,
    description: spec.description ?? `fake ${spec.name}`,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    async execute(args: Record<string, unknown>, ctx: ToolContext) {
      if (spec.delayMs) await new Promise(r => setTimeout(r, spec.delayMs))
      return spec.handler(args, ctx)
    },
  }
}
