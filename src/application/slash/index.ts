import { slashCancelCommand } from './builtin/slash-cancel'
import { slashClearCommand } from './builtin/slash-clear'
import { slashCompactCommand } from './builtin/slash-compact'
import { slashCostCommand } from './builtin/slash-cost'
import { slashDaemonCommand } from './builtin/slash-daemon'
import { slashExitCommand } from './builtin/slash-exit'
import { createSlashHelpCommand } from './builtin/slash-help'
import { slashToolsCommand } from './builtin/slash-tools'
import { slashNewCommand } from './builtin/slash-new'
import { slashSessionsCommand } from './builtin/slash-sessions'
import { slashResumeCommand } from './builtin/slash-resume'
import { slashPermissions } from './builtin/slash-permissions'
import type { SlashCommand } from './slash-types'
import type { SlashRegistry } from './slash-registry'

export type {
  SlashCommand, SlashContext, SlashResolution, SlashSource,
  ParsedSlash, SlashGroup, PromptSubmission,
} from './slash-types'
export { SlashRegistry } from './slash-registry'
export {
  filterCommands, getSlashQuery, getBestCompletion,
  getHighlightedCommandName, insertSlashCommand, buildPromptSubmission,
} from './slash-utils'

export function registerBuiltinSlashCommands(
  r: SlashRegistry,
  opts?: { include?: ReadonlyArray<string>; exclude?: ReadonlyArray<string> },
): void {
  const all: SlashCommand[] = [
    slashClearCommand, slashCompactCommand, slashCostCommand, slashToolsCommand,
    slashExitCommand, slashDaemonCommand, slashCancelCommand,
    slashNewCommand, slashSessionsCommand, slashResumeCommand,
    createSlashHelpCommand(() => r),
    slashPermissions,
  ]
  const include = opts?.include ? new Set(opts.include) : null
  const exclude = opts?.exclude ? new Set(opts.exclude) : null
  for (const cmd of all) {
    if (include && !include.has(cmd.name)) continue
    if (exclude && exclude.has(cmd.name)) continue
    r.register(cmd)
  }
}
