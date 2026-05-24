import type { SubAgentDescriptor } from './types'

export class SubAgentRegistry {
  private descriptors = new Map<string, SubAgentDescriptor>()

  register(desc: SubAgentDescriptor): void {
    const existing = this.descriptors.get(desc.type)
    if (existing) {
      if (existing.source === 'builtin') {
        throw new Error(`Cannot override builtin sub-agent type "${desc.type}"`)
      }
      // Extension can be overridden
    }
    this.descriptors.set(desc.type, desc)
  }

  get(type: string): SubAgentDescriptor | undefined {
    return this.descriptors.get(type)
  }

  list(): SubAgentDescriptor[] {
    return [...this.descriptors.values()]
  }

  clear(): void {
    this.descriptors.clear()
  }
}

export function registerBuiltins(registry: SubAgentRegistry): void {
  registry.register({
    type: 'explore',
    description: 'Search the codebase — find files, patterns, and architecture without modifying anything.',
    systemPrompt: 'You are a codebase explorer. Investigate the codebase and answer questions. DO NOT modify any files. DO NOT run bash commands that write. Cite exact file paths and line numbers in your answers. Use read/grep/glob/ls to explore. Output findings concisely.',
    allowedToolNames: ['read', 'grep', 'glob', 'ls', 'web_search', 'web_fetch'],
    maxRounds: 8,
    maxOutputTokens: 4096,
    modelHint: 'fast',
    source: 'builtin',
  })

  registry.register({
    type: 'plan',
    description: 'Produce a numbered step-by-step implementation plan with acceptance criteria and risk assessment.',
    systemPrompt: 'You are a planning assistant. Given a task description, produce a numbered list of implementation steps. For each step, include: (1) what files to create or modify, (2) what the change achieves, (3) acceptance criteria. Do NOT modify files. Do NOT call todo_write. Output your plan in structured markdown.',
    allowedToolNames: ['read', 'grep', 'glob', 'ls'],
    maxRounds: 5,
    maxOutputTokens: 8192,
    modelHint: 'fast',
    source: 'builtin',
  })

  registry.register({
    type: 'general-purpose',
    description: 'Complete a self-contained sub-task — search, read, and make changes as needed.',
    systemPrompt: 'You are a sub-agent. Complete the assigned task autonomously. You may search, read, and make changes within scope. Report what you did concisely. Do NOT ask the user questions — work independently and return results.',
    allowedToolNames: ['read', 'grep', 'glob', 'ls', 'bash', 'text_editor', 'web_search', 'web_fetch'],
    maxRounds: 12,
    maxOutputTokens: 8192,
    modelHint: 'strong',
    source: 'builtin',
  })
}
