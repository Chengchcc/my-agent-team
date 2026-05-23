import type { SlashCommand, ParsedSlash, SlashGroup } from './slash-types'

const DEFAULT_SOURCE_PRIORITY = 99
const SOURCE_PRIORITY: Record<string, number> = { builtin: 0, ext: 1, agent: 2, skill: 3 }

export class SlashRegistry {
  private commands = new Map<string, SlashCommand>()
  private aliases = new Map<string, string>()

  register(cmd: SlashCommand): void {
    const existing = this.commands.get(cmd.name)
    if (existing) {
      const cmdPriority = SOURCE_PRIORITY[cmd.source] ?? DEFAULT_SOURCE_PRIORITY
      const existingPriority = SOURCE_PRIORITY[existing.source] ?? DEFAULT_SOURCE_PRIORITY
      if (cmdPriority > existingPriority) return // skip lower priority
      if (cmdPriority === existingPriority) {
        // Same-source duplicate — warn but allow first registration to stand
        console.warn(`SlashRegistry: duplicate registration of "/${cmd.name}" (source: ${cmd.source}), keeping existing`)
        return
      }
    }
    this.commands.set(cmd.name, cmd)
    for (const alias of cmd.aliases ?? []) {
      this.aliases.set(alias, cmd.name)
    }
  }

  unregister(name: string): void {
    const cmd = this.commands.get(name)
    if (!cmd) return
    for (const alias of cmd.aliases ?? []) this.aliases.delete(alias)
    this.commands.delete(name)
  }

  unregisterBySource(source: string): void {
    for (const [name, cmd] of this.commands) {
      if (cmd.source === source) this.unregister(name)
    }
  }

  get(name: string): SlashCommand | undefined {
    return this.commands.get(name) ?? (this.aliases.has(name) ? this.commands.get(this.aliases.get(name)!) : undefined)
  }

  list(filter?: { source?: string; group?: string }): SlashCommand[] {
    let cmds = [...this.commands.values()]
    if (filter?.source) cmds = cmds.filter(c => c.source === filter.source)
    if (filter?.group) cmds = cmds.filter(c => c.group === filter.group)
    return cmds
  }

  /**
   * Parse and resolve "/commandName argv..." against registered commands.
   *
   * ⚠️ DE-DUP WARNING: `parseSlashArgs()` (slash-args.ts) also parses slash command
   * text into {name, argv, args, raw} but does NOT validate against the registry.
   * These two parsers MUST stay in sync. If you change the parsing logic here,
   * update parseSlashArgs() too, and vice versa.
   */
  resolve(raw: string): ParsedSlash | null {
    const trimmed = raw.trim()
    if (!trimmed.startsWith('/')) return null
    const parts = trimmed.slice(1).split(/\s+/)
    const name = parts[0]!
    const argv = parts.slice(1)
    const cmd = this.get(name)
    if (!cmd) return null
    return { command: cmd, argv }
  }

  getGroups(): SlashGroup[] {
    const groups = new Map<string, SlashCommand[]>()
    for (const cmd of this.commands.values()) {
      const g = cmd.group ?? 'other'
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g)!.push(cmd)
    }
    return [...groups.entries()].map(([name, commands]) => ({ name, commands }))
  }
}
