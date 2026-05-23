import type { SlashCommand, PromptSubmission } from './slash-types'

const DESCRIPTION_CONTAINS_SCORE = 3

function normalizeCommandName(name: string): string {
  return name.toLowerCase().trim()
}

function scoreCommandMatch(command: SlashCommand, filter: string): number {
  const name = command.name.toLowerCase()
  if (name.startsWith(filter)) return 0
  if (isSubsequenceMatch(name, filter)) return 1
  if (name.includes(filter)) return 2
  return DESCRIPTION_CONTAINS_SCORE
}

function isSubsequenceMatch(text: string, filter: string): boolean {
  let ti = 0, fi = 0
  while (ti < text.length && fi < filter.length) {
    if (text[ti] === filter[fi]) fi++
    ti++
  }
  return fi === filter.length
}

export function filterCommands(commands: SlashCommand[], filter: string): SlashCommand[] {
  const normalizedFilter = normalizeCommandName(filter)
  if (!normalizedFilter) return commands
  return commands
    .filter(cmd => {
      const name = cmd.name.toLowerCase()
      const desc = cmd.description.toLowerCase()
      return name.includes(normalizedFilter) || desc.includes(normalizedFilter)
    })
    .sort((a, b) => scoreCommandMatch(a, normalizedFilter) - scoreCommandMatch(b, normalizedFilter))
}

export function getSlashQuery(text: string): string | null {
  if (!text.startsWith('/')) return null
  const match = text.match(/^\/([^\s]+)/)
  return match?.[1] ?? null
}

export function insertSlashCommand(command: SlashCommand): string {
  return `/${command.name} `
}

export function getHighlightedCommandName(text: string, commands: SlashCommand[]): string | null {
  const match = text.match(/^\/([^\s]+)(?:\s|$)/)
  if (!match?.[1]) return null
  const commandName = normalizeCommandName(match[1])
  return commands.some(c => c.name.toLowerCase() === commandName) ? match[1] : null
}

export function getBestCompletion(query: string, commands: SlashCommand[]): string | null {
  const matches = filterCommands(commands, query)
  if (matches.length === 0) return null
  if (matches.length === 1) return matches[0]!.name
  const names = matches.map(c => c.name)
  let prefix = names[0]!
  for (let i = 1; i < names.length; i++) {
    while (!names[i]!.startsWith(prefix)) {
      prefix = prefix.slice(0, -1)
      if (prefix === '') return null
    }
  }
  return prefix.length > query.length ? prefix : null
}

/** Pure variant: caller resolves platform-specific text (e.g. paste placeholders) before calling. */
export function buildPromptSubmission(resolvedText: string, commands: SlashCommand[]): PromptSubmission {
  const slashQuery = getSlashQuery(resolvedText.trim())
  if (slashQuery === null) return { text: resolvedText, requestedSkillName: null }
  const matched = commands.find(c => c.name.toLowerCase() === slashQuery.toLowerCase() && c.source === 'skill')
  if (matched) return { text: resolvedText, requestedSkillName: matched.name }
  return { text: resolvedText, requestedSkillName: null }
}
