import type { ExtractJob } from './types'
import type { TraceRun } from '../../domain/trace/types'

const TURN_PREVIEW_CHARS = 400
const MAX_TURNS_IN_PROMPT = 20
const EXTRACT_MAX_TOKENS = 800

const SYSTEM_PROMPT = `You extract durable, reusable knowledge from a single agent conversation.

Output rules:
- One candidate per paragraph, separated by a blank line.
- Each paragraph starts with one or more #tags on its first line.
- Allowed tags: #preference #decision #fact #general (use the most specific).
- The body (everything after the tags) is the knowledge sentence — make it self-contained and re-readable months later.
- Drop trivia: greetings, one-off file paths, project-specific minutiae the next session won't reuse.
- If nothing durable, output exactly: NONE

Example:
#preference #tools
User prefers ripgrep over grep for code search and asks for case-insensitive matches by default.

#decision #architecture
Adopt SQLite (bun:sqlite) as the default persistence layer across session/trace/evolution/memory stores; in-memory variants removed.`

function formatRunForExtract(run: TraceRun): string {
  const head = [
    `Run ${run.id}  session=${run.sessionId}  model=${run.model}`,
    `turns=${run.summary.totalTurns}  tools=${run.summary.totalToolCalls}  errors=${run.summary.totalErrors}  outcome=${run.summary.outcome}`,
    '',
  ]
  const turns = run.turns.slice(-MAX_TURNS_IN_PROMPT)
  const body: string[] = []
  for (const t of turns) {
    body.push(`--- Turn ${t.turnIndex} ---`)
    if (t.userMessage) body.push(`User: ${t.userMessage.slice(0, TURN_PREVIEW_CHARS)}`)
    if (t.modelResponse?.text) body.push(`Agent: ${t.modelResponse.text.slice(0, TURN_PREVIEW_CHARS)}`)
    const tools = t.modelResponse?.toolCalls.map(c => c.name).join(', ')
    if (tools) body.push(`Tools: ${tools}`)
  }
  return head.concat(body, '', 'Extract knowledge from the above conversation following the output rules.').join('\n')
}

export function buildExtractPrompt(job: ExtractJob): {
  messages: Array<{ role: 'system' | 'user'; content: string }>
  maxTokens: number
} {
  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: formatRunForExtract(job.run) },
    ],
    maxTokens: EXTRACT_MAX_TOKENS,
  }
}
