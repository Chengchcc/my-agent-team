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
import { ContradictionResolver } from './contradiction-resolver'
import type { InvokeFn } from '../../application/ports/job-spawner'
import type { MemoryEntry } from '../../domain/memory-entry'
import { RememberUseCase } from './explicit-write/remember-use-case'
import type { RememberInput } from './explicit-write/remember-use-case'
import { ForgetUseCase } from './explicit-write/forget-use-case'
import type { ForgetInput } from './explicit-write/forget-use-case'
import { rememberToolDef, forgetToolDef } from './explicit-write/tool-defs'
import type { ExtractJob, ExtractResult } from './types'
import type { EventEnvelope } from '../../application/contracts/event-envelope'
import type { TurnCompletedV1, TurnFailedV1 } from '../../application/contracts/session-events'
import type { CliManifest } from '../../cli/cli-types'
import type { AssertHasCliManifest } from '../../cli/assert-cli-bearing'
import { defineTool } from '../../application/tool-factory/define-tool'
import type { MemoryType } from '../../domain/memory-entry'

const EXTRACT_TIMEOUT_MS = 60_000
const MAX_INFLIGHT = 1
const MEM_COLUMNS = { id: 12, idPad: 14, type: 12, weight: 6 } as const
const MEM_DEFAULT_LIST_LIMIT = 50
const MEM_DEFAULT_SEARCH_LIMIT = 20
const MEM_TEXT_PREVIEW_CHARS = 60
const MEM_SEARCH_TEXT_PREVIEW_CHARS = 100
const SEMANTIC_DEDUP_DEFAULT_THRESHOLD = 0.12
const CONTRADICTION_TOP_K = 3
const PRUNE_DEFAULT_AFTER_DAYS = 180

function inferType(tags: string[]): MemoryType {
  if (tags.includes('preference') || tags.includes('pref')) return 'preference'
  if (tags.includes('decision')) return 'decision'
  if (tags.includes('fact')) return 'fact'
  if (tags.includes('instruction')) return 'instruction'
  return 'fact'
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
        await ctx.rpc('memory.forget-by-id', { id: argv[1] })
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

// eslint-disable-next-line max-lines-per-function -- extension wiring function, see apply() justify comment
export default (opts: MemoryOpts = {}) =>
  defineExtension({
    name: 'memory',
    enforce: 'normal',
    dependsOn: ['trace', 'tool-catalog'],
    // eslint-disable-next-line max-lines-per-function -- extension apply() naturally wires many capabilities (provide, rpc, tools, hooks, subscribe); extracted where feasible
    apply: (ctx) => {
      const bus = asContractBus(ctx.bus)
      const baseDir = opts.baseDir ?? ctx.paths.memory
      mkdirSync(baseDir, { recursive: true })
      const db = openDb(join(baseDir, 'memory.db'))
      const store = createSqliteMemoryStore(db)
      const encoder = createOllamaEncoder(opts.embedding ?? {})
      const reader = ctx.extensions.get('trace.reader')
      const spawner = ctx.extensions.has('infra-services.job-spawner')
        ? ctx.extensions.get('infra-services.job-spawner')
        : undefined
      const ctxFactory = ctx.extensions.has('infra-services.job-context-factory')
        ? ctx.extensions.get('infra-services.job-context-factory')
        : undefined
      const recall = createRecall(store, encoder, opts.weights)
      const debugLog = (d: string, m: string) => ctx.logger.debug(d, m)
      const backfill = createEmbeddingBackfill(store, encoder, debugLog)
      const dedup = new DedupPipeline(store, encoder)
      const invokeFn: InvokeFn | undefined = ctx.extensions.has('provider.llm')
        ? ctx.extensions.get('provider.llm') as unknown as InvokeFn | undefined
        : undefined
      const resolver = new ContradictionResolver(store, encoder, invokeFn)
      const catalog = ctx.extensions.get('tool-catalog.catalog')
      const state: PolicyState = { turnsSinceExtract: 0 }
      let inflight = 0

      // Explicit-write use cases
      const explicitCfg = ctx.config.raw.memory as Record<string, unknown> | undefined;
      const explicit = (explicitCfg?.explicit ?? {}) as {
        enabled?: boolean; perTurnLimit?: number; defaultWeight?: number; explicitSourceWeightBoost?: number;
      };
      const rememberUseCase = new RememberUseCase(store, encoder, dedup, bus, {
        perTurnLimit: explicit.perTurnLimit,
        defaultWeight: explicit.defaultWeight,
      })
      const forgetUseCase = new ForgetUseCase(store, encoder, bus)

      // Lifecycle config with defaults
      const lifecycleCfg = ctx.config.raw.memory as Record<string, unknown> | undefined;
      const lifecycle = (lifecycleCfg?.lifecycle ?? {}) as {
        semanticDedupThreshold?: number; pruneAfterDays?: number; pruneMinUsageCount?: number;
      };
      const semanticThreshold = lifecycle.semanticDedupThreshold ?? SEMANTIC_DEDUP_DEFAULT_THRESHOLD

      catalog.register(defineTool({
        name: rememberToolDef.name,
        description: rememberToolDef.description,
        parameters: rememberToolDef.parameters,
        parse: (raw) => raw as unknown as RememberInput as unknown as Record<string, unknown>,
        execute: async (_toolCtx, params) =>
          rememberUseCase.execute(params as unknown as RememberInput, _toolCtx.turnId),
      }))
      catalog.register(defineTool({
        name: forgetToolDef.name,
        description: forgetToolDef.description,
        parameters: forgetToolDef.parameters,
        parse: (raw) => raw as unknown as ForgetInput as unknown as Record<string, unknown>,
        execute: async (_toolCtx, params) => forgetUseCase.execute(params as unknown as ForgetInput),
      }))

      return {
        provide: {
          'memory.recall': () => recall,
          'memory.store': () => store,
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
          'memory.forget-by-id': async (params: unknown) => {
            const p = params as { id?: string } | undefined
            if (!p?.id) throw new Error('id is required')
            const ok = await store.remove(p.id)
            return { removed: ok }
          },
          'memory.remember': async (params: unknown) => {
            return rememberUseCase.execute(params as RememberInput)
          },
          'memory.forget': async (params: unknown) => {
            return forgetUseCase.execute(params as ForgetInput)
          },
          'memory.prune': async (params: unknown) => {
            const p = params as { dryRun?: boolean } | undefined;
            const cfg = lifecycle;
            const candidates = await store.findPruneCandidates({
              olderThanDays: cfg.pruneAfterDays ?? PRUNE_DEFAULT_AFTER_DAYS,
              maxUsageCount: cfg.pruneMinUsageCount ?? 0,
            });
            if (p?.dryRun) {
              return { wouldDelete: candidates.length, ids: candidates };
            }
            await store.removeMany(candidates);
            void bus.emit(createEvent('memory.prune.applied', {
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
                const registry = ctx.extensions.get('agent.registry')
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
            rememberUseCase.clearTurn(e.turnId)
            const decision = evaluateExtractPolicy(e, state)
            if (decision.kind === 'skip' || inflight >= MAX_INFLIGHT) return
            if (!spawner || !ctxFactory) return

            const run = await reader.getRun(e.turnId)
            if (!run) return

            inflight++
            void bus.emit(createEvent('memory.extract.started', { runId: e.turnId }))
            try {
              const result = await spawner.run<ExtractJob, ExtractResult>({
                entry: require.resolve('./extract-worker'),
                job: { runId: e.turnId, run },
                ctx: ctxFactory({ runId: e.turnId }),
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
                    void store.incrementMergeCount(result_.existingId)
                    void bus.emit(createEvent('memory.dedup', { kind: 'exact', existingId: result_.existingId }))
                    continue
                  case 'duplicate-semantic':
                    void store.markHit([result_.existingId])
                    void store.incrementMergeCount(result_.existingId)
                    void bus.emit(createEvent('memory.dedup', { kind: 'semantic', existingId: result_.existingId }))
                    continue
                  case 'contradiction':
                  case 'new':
                    break
                }
                // Check for contradictions with existing entries
                try {
                  const conflicts = await resolver.checkConflicts(
                    { text: c.text, type },
                    CONTRADICTION_TOP_K,
                  )
                  if (conflicts.hasConflict && invokeFn) {
                    try {
                      const decision = await resolver.arbitrate(
                        { id: crypto.randomUUID(), type, text: c.text, tags: c.tags, weight: c.weight, source: 'implicit', createdAt: new Date(), updatedAt: new Date(), usageCount: 0, supersededBy: undefined, mergeCount: 0 } as MemoryEntry,
                        conflicts.conflicts,
                      )
                      if (decision.decision === 'keep_old') continue
                      if (decision.decision === 'merge' && decision.mergedText) {
                        c.text = decision.mergedText
                      }
                      for (const conflict of conflicts.conflicts) {
                        try { void store.remove(conflict.id) } catch { /* best-effort */ }
                      }
                    } catch (arbErr) {
                      ctx.logger.warn('memory', `arbitration failed: ${String(arbErr)}`)
                      throw arbErr
                    }
                  }
                } catch { /* non-critical — skip conflict check on embed failure */ }
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
                  await store.storeEmbedding(newEntry.id, emb)
                } catch { /* non-critical */ }
              }
              void bus.emit(createEvent('memory.extract.completed', { runId: e.turnId, count: result.candidates.length }))
            } catch (err) {
              ctx.logger.warn('memory', `extract failed: ${String(err)}`)
              void bus.emit(createEvent('memory.extract.failed', { runId: e.turnId, message: String(err) }))
            } finally {
              inflight--
            }
          },

          'turn.failed': async (raw) => {
            const e = (raw as EventEnvelope<'turn.failed', TurnFailedV1>).payload
            rememberUseCase.clearTurn(e.turnId)
            void evaluateExtractPolicy(e, state) // update counter even on failure
          },
        },

        slash: [slashMemory],
        dispose: async () => { backfill.stop(); db.close() },
      }
    },
  })
