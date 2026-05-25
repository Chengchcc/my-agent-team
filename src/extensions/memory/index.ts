import { defineExtension } from '../../kernel/define-extension'
import { slashMemory } from './slash/slash-memory'
import { createEvent } from '../../application/contracts'
import { asContractBus } from '../../application/event-bus/contract-bus'
import { createSqliteMemoryStore } from '../../infrastructure/memory'
import { openDb } from '../../infrastructure/_sqlite/connection'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createOllamaEncoder } from './embedding-encoder'
import { createRecall } from './recall'
import { createEmbeddingBackfill } from './embedding-backfill'
import { evaluateExtractPolicy, type PolicyState } from './policy'
import { DedupPipeline } from './dedup-pipeline'
import type { JobSpawner } from '../../application/ports/job-spawner'
import type { JobContextFactory } from '../infra-services/job-context-factory'
import type { TraceReader } from '../../application/ports/trace-checkpointer'
import type { ExtractJob, ExtractResult } from './types'
import type { EventEnvelope } from '../../application/contracts/event-envelope'
import type { TurnCompletedV1, TurnFailedV1 } from '../../application/contracts/session-events'
import type { CliManifest } from '../../cli/cli-types'
import type { AssertHasCliManifest } from '../../cli/assert-cli-bearing'
import type { MemoryType } from '../../domain/memory-entry'
import type { AgentRegistryRead } from '../../application/ports/agent-registry'

const EXTRACT_TIMEOUT_MS = 60_000
const MAX_INFLIGHT = 1
const MEM_COLUMNS = { id: 12, idPad: 14, type: 12, weight: 6 } as const
const MEM_DEFAULT_LIST_LIMIT = 50
const MEM_DEFAULT_SEARCH_LIMIT = 20
const MEM_TEXT_PREVIEW_CHARS = 60
const MEM_SEARCH_TEXT_PREVIEW_CHARS = 100

function inferType(tags: string[]): MemoryType {
  if (tags.includes('preference') || tags.includes('pref')) return 'user_preference'
  if (tags.includes('decision')) return 'project_rule'
  if (tags.includes('fact')) return 'agent_md'
  return 'general'
}

export const cliManifest: CliManifest = {
  name: 'memory',
  description: 'List, search, and manage agent memories',
  usage: [
    '  my-agent memory list [--limit N] [--type general|preference]',
    '  my-agent memory search <query> [--limit N]',
    '  my-agent memory forget <id>',
    '  my-agent memory prune [--dry-run]',
  ].join('\n'),
  handler: async (argv, ctx) => {
    const sub = argv[0]
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- default handles undefined
    switch (sub) {
      case 'list': {
        const limitIdx = argv.indexOf('--limit')
        const limit = limitIdx >= 0 ? parseInt(argv[limitIdx + 1]!, 10) : MEM_DEFAULT_LIST_LIMIT
        const typeIdx = argv.indexOf('--type')
        const type = typeIdx >= 0 ? argv[typeIdx + 1] : undefined
        const result = await ctx.rpc('memory.list', { limit, type })
        const data = result as { entries: Array<{ id: string; type: string; text: string; weight: number; createdAt: unknown }> }
        if (data.entries.length === 0) {
          ctx.out('No memories found.\n')
          return
        }
        for (const e of data.entries) {
          const preview = e.text.length > MEM_TEXT_PREVIEW_CHARS ? e.text.slice(0, MEM_TEXT_PREVIEW_CHARS) + '...' : e.text
          ctx.out(`${e.id.slice(0, MEM_COLUMNS.id).padEnd(MEM_COLUMNS.idPad)} ${e.type.padEnd(MEM_COLUMNS.type)} ${String(e.weight).padEnd(MEM_COLUMNS.weight)} ${preview}\n`)
        }
        ctx.out(`\n${data.entries.length} entries\n`)
        return
      }
      case 'search': {
        if (!argv[1]) { ctx.err('missing <query>\n'); process.exit(2) }
        const query = argv[1]
        const limitIdx = argv.indexOf('--limit')
        const limit = limitIdx >= 0 ? parseInt(argv[limitIdx + 1]!, 10) : MEM_DEFAULT_SEARCH_LIMIT
        const result = await ctx.rpc('memory.search', { query, limit })
        const data = result as { entries: Array<{ id: string; text: string; weight: number }> }
        if (data.entries.length === 0) {
          ctx.out('No matches.\n')
          return
        }
        for (const e of data.entries) {
          ctx.out(`${e.id.slice(0, MEM_COLUMNS.id).padEnd(MEM_COLUMNS.idPad)} ${String(e.weight).padEnd(MEM_COLUMNS.weight)} ${e.text.slice(0, MEM_SEARCH_TEXT_PREVIEW_CHARS)}\n`)
        }
        return
      }
      case 'forget': {
        if (!argv[1]) { ctx.err('missing <id>\n'); process.exit(2) }
        await ctx.rpc('memory.forget', { id: argv[1] })
        ctx.out(`Forgot ${argv[1]}\n`)
        return
      }
      case 'prune': {
        const dryRun = argv.includes('--dry-run')
        const result = await ctx.rpc('memory.prune', { dryRun })
        const data = result as { deleted?: number; wouldDelete?: number; ids?: string[] }
        if (dryRun) {
          ctx.out(`Would delete ${data.wouldDelete} entries\n`)
        } else {
          ctx.out(`Deleted ${data.deleted} entries\n`)
        }
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

interface MemoryOpts {
  baseDir?: string
  embedding?: { baseUrl?: string; model?: string }
  weights?: { vector?: number; bm25?: number; keyword?: number }
}

export default (opts: MemoryOpts = {}) =>
  defineExtension({
    name: 'memory',
    enforce: 'normal',
    dependsOn: ['trace'],
    apply: (ctx) => {
      const bus = asContractBus(ctx.bus)
      const baseDir = opts.baseDir ?? ctx.paths.memory
      mkdirSync(baseDir, { recursive: true })
      const db = openDb(join(baseDir, 'memory.db'))
      const store = createSqliteMemoryStore(db)
      const encoder = createOllamaEncoder(opts.embedding ?? {})
      const reader = ctx.extensions.get<TraceReader>('trace.reader')
      const spawner = ctx.extensions.has('infra-services.job-spawner')
        ? ctx.extensions.get<JobSpawner>('infra-services.job-spawner')
        : undefined
      const ctxFactory = ctx.extensions.has('infra-services.job-context-factory')
        ? ctx.extensions.get<JobContextFactory>('infra-services.job-context-factory')
        : undefined
      const recall = createRecall(store, encoder, opts.weights)
      const debugLog = (d: string, m: string) => ctx.logger.debug(d, m)
      const backfill = createEmbeddingBackfill(store, encoder, debugLog)
      const dedup = new DedupPipeline(store, encoder)
      const state: PolicyState = { turnsSinceExtract: 0 }
      let inflight = 0

      // Lifecycle config with defaults
      const lifecycleCfg = (ctx.config as Record<string, unknown>).memory as Record<string, unknown> | undefined;
      const lifecycle = (lifecycleCfg?.lifecycle ?? {}) as {
        semanticDedupThreshold?: number; pruneAfterDays?: number; pruneMinUsageCount?: number;
      };
      const semanticThreshold = lifecycle.semanticDedupThreshold ?? 0.12

      return {
        provide: {
          recall: () => recall,
          store: () => store,
        },

        rpc: {
          'memory.list': async (params: unknown) => {
            const p = params as { limit?: number; type?: string } | undefined
            const mtype = p?.type ? (p.type as MemoryType) : undefined
            const entries = mtype ? await store.getByType(mtype, p?.limit ?? MEM_DEFAULT_LIST_LIMIT) : await store.getAll()
            return { entries: entries.slice(0, p?.limit ?? MEM_DEFAULT_LIST_LIMIT).map(e => ({ id: e.id, type: e.type, text: e.text, weight: e.weight })) }
          },
          'memory.search': async (params: unknown) => {
            const p = params as { query?: string; limit?: number } | undefined
            if (!p?.query) throw new Error('query is required')
            const entries = await store.ftsSearch(p.query, p?.limit ?? MEM_DEFAULT_SEARCH_LIMIT)
            return { entries: entries.slice(0, p?.limit ?? MEM_DEFAULT_SEARCH_LIMIT).map(e => ({ id: e.id, type: e.type, text: e.text, weight: e.weight })) }
          },
          'memory.forget': async (params: unknown) => {
            const p = params as { id?: string } | undefined
            if (!p?.id) throw new Error('id is required')
            const ok = await store.remove(p.id)
            return { removed: ok }
          },
          'memory.prune': async (params: unknown) => {
            const p = params as { dryRun?: boolean } | undefined;
            const cfg = lifecycle;
            const candidates = await store.findPruneCandidates({
              olderThanDays: cfg.pruneAfterDays ?? 180,
              maxUsageCount: cfg.pruneMinUsageCount ?? 0,
            });
            if (p?.dryRun) {
              return { wouldDelete: candidates.length, ids: candidates };
            }
            await store.removeMany(candidates);
            bus.emit(createEvent('memory.prune.applied', {
              deletedCount: candidates.length,
              dryRun: false,
            }));
            return { deleted: candidates.length };
          },
        },

        hooks: {
          kernelReady: { enforce: 'normal', fn: async () => { backfill.start() } },
          onShutdown: { enforce: 'pre', fn: async () => { backfill.stop() } },
          transformPrompt: {
            enforce: 'normal',
            fn: async (...args: unknown[]) => {
              const prompt = args[0] as { system: string }
              try {
                const registry = ctx.extensions.get<AgentRegistryRead>('agent.registry')
                if (registry) {
                  try {
                    const rec = await registry.current()
                    if (rec.identityStatus === 'pending_bootstrap') return prompt
                  } catch { /* proceed */ }
                }
              } catch { /* proceed */ }
              return prompt
            },
          },
        },

        subscribe: {
          'turn.completed': async (raw) => {
            const e = (raw as EventEnvelope<'turn.completed', TurnCompletedV1>).payload
            const decision = evaluateExtractPolicy(e, state)
            if (decision.kind === 'skip' || inflight >= MAX_INFLIGHT) return
            if (!spawner || !ctxFactory) return

            const run = await reader.getRun(e.runId)
            if (!run) return

            inflight++
            bus.emit(createEvent('memory.extract.started', { runId: e.runId }))
            try {
              const result = await spawner.run<ExtractJob, ExtractResult>({
                entry: require.resolve('./extract-worker'),
                job: { runId: e.runId, run },
                ctx: ctxFactory({ purpose: 'memory.extract', runId: e.runId }),
                timeoutMs: EXTRACT_TIMEOUT_MS,
              })
              for (const c of result.candidates) {
                const type = inferType(c.tags)
                const result_ = await dedup.process(
                  { text: c.text, type, tags: c.tags, weight: c.weight },
                  { semanticThreshold },
                )
                switch (result_.kind) {
                  case 'duplicate-exact':
                    void store.markHit([result_.existingId])
                    bus.emit(createEvent('memory.dedup', { kind: 'exact', existingId: result_.existingId }))
                    continue
                  case 'duplicate-semantic':
                    void store.markHit([result_.existingId])
                    void store.incrementMergeCount(result_.existingId)
                    bus.emit(createEvent('memory.dedup', { kind: 'semantic', existingId: result_.existingId }))
                    continue
                  case 'contradiction':
                    // Full contradiction resolution requires InvokeFn — deferred to Spec 3 (explicit write).
                    // For now, treat as new.
                    break
                  case 'new':
                    break
                }
                const newEntry = await store.add({
                  type,
                  text: c.text,
                  weight: c.weight,
                  source: 'implicit',
                  tags: c.tags,
                  usageCount: 0,
                })
                // Store embedding for future semantic dedup
                try {
                  const emb = await encoder.encode(c.text)
                  void store.storeEmbedding(newEntry.id, emb)
                } catch { /* non-critical */ }
              }
              bus.emit(createEvent('memory.extract.completed', { runId: e.runId, count: result.candidates.length }))
            } catch (err) {
              ctx.logger.warn('memory', `extract failed: ${String(err)}`)
              bus.emit(createEvent('memory.extract.failed', { runId: e.runId, message: String(err) }))
            } finally {
              inflight--
            }
          },

          'turn.failed': async (raw) => {
            const e = (raw as EventEnvelope<'turn.failed', TurnFailedV1>).payload
            void evaluateExtractPolicy(e, state) // update counter even on failure
          },
        },

        slash: [slashMemory],
        dispose: async () => { backfill.stop(); db.close() },
      }
    },
  })
