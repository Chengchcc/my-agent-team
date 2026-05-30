import type { SlashCommand, SlashResolution } from '../slash-types'
import { SLASH_GROUPS } from '../slash-groups'

export function createSlashHelpCommand(
  getRegistry: () => { list: (f?: { source?: string; group?: string }) => Array<{ name: string; description: string; group?: string }> }
): SlashCommand {
  return {
    name: 'help',
    description: 'Show available commands grouped by category',
    source: 'builtin',
    group: 'core',
    async resolve(_input, ctx): Promise<SlashResolution> {
      const registry = getRegistry()
      const all = registry.list({ source: 'builtin' })
      const grouped = new Map<string, Array<{ name: string; description: string }>>()
      for (const cmd of all) {
        const grp = cmd.group ?? 'other'
        if (!grouped.has(grp)) grouped.set(grp, [])
        grouped.get(grp)!.push({ name: cmd.name, description: cmd.description })
      }
      const lines: string[] = ['Available commands:\n']
      for (const g of SLASH_GROUPS) {
        const cmds = grouped.get(g.name)
        if (!cmds || cmds.length === 0) continue
        lines.push(`**${g.name}**`)
        for (const c of cmds) {
          lines.push(`  /${c.name} — ${c.description}`)
        }
        lines.push('')
      }

      // Keyboard shortcuts via ctx.ui.getCheatsheet (TUI only)
      const cheatsheet = ctx.ui?.getCheatsheet?.() ?? [];
      if (cheatsheet.length > 0) {
        lines.push('\n**Keyboard shortcuts**\n');
        for (const group of cheatsheet) {
          if (group.bindings.length === 0) continue;
          lines.push(`_${group.scope}_`);
          for (const b of group.bindings) {
            lines.push(`  ${b.label} — ${b.description}`);
          }
          lines.push('');
        }
      }

      return { kind: 'handled', message: lines.join('\n') }
    },
  }
}
