import type { ModeDescriptor } from './types'
import { PLAN_MODE_PROMPT } from './prompts/plan'

export class ModeRegistry {
  private descriptors = new Map<string, ModeDescriptor>()

  register(desc: ModeDescriptor): void {
    const existing = this.descriptors.get(desc.name)
    if (existing?.source === 'builtin') {
      throw new Error(`Cannot override builtin mode "${desc.name}"`)
    }
    this.descriptors.set(desc.name, desc)
  }

  get(name: string): ModeDescriptor | undefined {
    return this.descriptors.get(name)
  }

  list(): ModeDescriptor[] {
    return [...this.descriptors.values()]
  }
}

export function registerBuiltinModes(registry: ModeRegistry): void {
  registry.register({
    name: 'plan',
    description: 'Research and propose a plan without making changes.',
    systemPromptAppend: PLAN_MODE_PROMPT,
    toolFilter: (t) =>
      t.readonly === true || t.name === 'todo_write' || t.name === 'exit_plan_mode',
    source: 'builtin',
  })
}
