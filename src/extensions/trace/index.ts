import { defineExtension } from '../../kernel/define-extension'
import { slashTrace } from './slash/slash-trace'
import type { HookHandler } from '../../kernel/define-extension'
import { SqliteTraceCheckpointer } from '../../infrastructure/trace/sqlite-trace-checkpointer'
import { openDb, runMigrations } from '../../infrastructure/_sqlite/connection'
import { traceMigrations } from '../../infrastructure/trace/sqlite-trace-schema'
import type { TraceEvent } from '../../domain/trace-event'
import type { TraceReader } from '../../application/ports/trace-checkpointer'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CliManifest } from '../../cli/cli-types'
import type { AssertHasCliManifest } from '../../cli/assert-cli-bearing'

const TRACE_COLUMNS = { id: 28, session: 10, turns: 6 } as const
const TRACE_DEFAULT_LIMIT = 20

/**
 * Trace extension — persists trace events via TraceCheckpointer.
 *
 * Capabilities exposed:
 *   - trace.reader: TraceReader (getRun + listRecentSummaries)
 *
 * Hooks:
 *   - onTraceEmit (pre): append event to checkpointer
 *   - onShutdown (post): flush
 */
export const cliManifest: CliManifest = {
  name: 'trace',
  description: 'Inspect persisted trace runs',
  usage: [
    '  my-agent trace list [--limit N] [--session ID]',
    '  my-agent trace show <runId>',
  ].join('\n'),
  handler: async (argv, ctx) => {
    const sub = argv[0]
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- default handles undefined
    switch (sub) {
      case 'list': {
        const limitIdx = argv.indexOf('--limit')
        const limit = limitIdx >= 0 ? parseInt(argv[limitIdx + 1]!, 10) : TRACE_DEFAULT_LIMIT
        const sessionIdx = argv.indexOf('--session')
        const sessionId = sessionIdx >= 0 ? argv[sessionIdx + 1] : undefined
        const result = await ctx.rpc('trace.listRecent', { limit, sessionId })
        const data = result as { runs: Array<{ id: string; sessionId: string; totalTurns: number; outcome: string }> }
        if (data.runs.length === 0) {
          ctx.out('No trace runs found.\n')
          return
        }
        for (const r of data.runs) {
          ctx.out(`${r.id.padEnd(TRACE_COLUMNS.id)} ${(r.sessionId ?? '-').padEnd(TRACE_COLUMNS.session)} ${String(r.totalTurns).padEnd(TRACE_COLUMNS.turns)} ${r.outcome ?? '?'}\n`)
        }
        return
      }
      case 'show': {
        if (!argv[1]) { ctx.err('missing <runId>\n'); process.exit(2) }
        const result = await ctx.rpc('trace.getRun', { runId: argv[1] })
        ctx.out(JSON.stringify((result as { run: unknown }).run, null, 2) + '\n')
        return
      }
      default:
        ctx.err(`unknown subcommand: ${sub ?? '(none)'}\n`)
        ctx.err(cliManifest.usage + '\n')
        process.exit(2)
    }
  },
}

// Compile-time assertion
/**
 * @internal — compile-time satisfies check that this module exposes a CliManifest;
 * has no runtime consumer by design.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- typeof import pattern required for AssertHasCliManifest
export type _CheckCliManifest = AssertHasCliManifest<typeof import('./index')>

export default (opts?: { baseDir?: string }) =>
  defineExtension({
    name: 'trace',
    enforce: 'pre',

    apply: (ctx) => {
      const baseDir = opts?.baseDir ?? ctx.paths.traces
      mkdirSync(baseDir, { recursive: true })
      const db = openDb(join(baseDir, 'traces.db'))
      runMigrations(db, traceMigrations)
      const checkpointer = new SqliteTraceCheckpointer(db, `agent-${ctx.agentId}-${Date.now()}`)

      const onTraceEmit: HookHandler = async (...args: unknown[]) => {
        const event = args[0] as TraceEvent
        await checkpointer.append(event)
      }

      const onShutdown: HookHandler = async () => {
        await checkpointer.flush()
      }

      return {
        provide: {
          'trace.reader': () => checkpointer as unknown as TraceReader,
        },

        rpc: {
          'trace.listRecent': async (params: unknown) => {
            const p = params as { limit?: number; sessionId?: string } | undefined
            const reader = checkpointer as unknown as TraceReader
            const runs = await reader.listRecentRuns({
              limit: p?.limit ?? TRACE_DEFAULT_LIMIT,
              sessionId: p?.sessionId,
            })
            return { runs }
          },
          'trace.getRun': async (params: unknown) => {
            const p = params as { runId?: string } | undefined
            if (!p?.runId) throw new Error('runId is required')
            const reader = checkpointer as unknown as TraceReader
            const run = await reader.getRun(p.runId)
            if (!run) throw new Error(`run not found: ${p.runId}`)
            return {
              run: {
                id: run.id,
                sessionId: run.sessionId,
                events: run.turns.flatMap((t, i) => [
                  { type: 'turn.started', turnIndex: i, timestamp: new Date(run.startTime).toISOString() },
                  ...(t.userMessage ? [{ type: 'user.message', turnIndex: i, timestamp: new Date(run.startTime).toISOString() }] : []),
                  ...(t.modelResponse?.text ? [{ type: 'assistant.message', turnIndex: i, timestamp: new Date(run.startTime).toISOString() }] : []),
                  ...t.toolExecutions.map(e => ({
                    type: e.success ? 'tool.end' : 'tool.error',
                    turnIndex: i,
                    toolName: e.toolName,
                    timestamp: new Date(run.startTime).toISOString(),
                  })),
                ]),
              },
            }
          },
        },

        hooks: {
          onTraceEmit: { enforce: 'pre', fn: onTraceEmit },
          onShutdown: { enforce: 'post', fn: onShutdown },
        },

        slash: [slashTrace],
        dispose: () => { void checkpointer.flush(); db.close() },
      }
    },
  })
