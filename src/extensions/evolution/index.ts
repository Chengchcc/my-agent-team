import { defineExtension } from "../../kernel/define-extension"
import { slashEvolution } from "./slash/slash-evolution"
import { createEvent } from '../../application/contracts'
import { asContractBus } from '../../application/event-bus/contract-bus'
import type { EventEnvelope } from '../../application/contracts'
import { evaluateReviewPolicy, type PolicyState } from './policy'
import { bumpStat } from './skill-stats'
import { writeProposal } from './proposal-writer'
import { promoteToSkill } from './promote-writer'
import { StatsCollector } from './stats-collector'
import { evaluateRetireRules } from './auto-retire-rules'
import type { AutoRetireConfig } from './auto-retire-rules'
import { AutoRetirer } from './auto-retirer'
import type { JobSpawner } from '../../application/ports/job-spawner'
import type { TraceReader } from '../../application/ports/trace-checkpointer'
import type { ProposalStore } from '../../application/ports/proposal-store'
import type { SkillStatsStore } from '../../application/ports/skill-stats-store'
import type { SkillMetaRepo } from '../../application/ports/skill-meta-repo'
import type { ReviewJob, ReviewResult } from './types'
import type { JobContextFactory } from '../infra-services/job-context-factory'
import type { CliManifest } from '../../cli/cli-types'
import type { AssertHasCliManifest } from '../../cli/assert-cli-bearing'
import type { EvolutionReviewCompletedV1 } from '../../application/contracts/evolution-events'

const REVIEW_TIMEOUT_MS = 120_000
const MAX_INFLIGHT = 1
const EVO_COLUMNS = { id: 12, idPad: 14, tier: 8, outcome: 14, skill: 16, runs: 6, rate: 6, name: 24 } as const
const EVO_DEFAULT_LIMIT = 20

// Auto-retire config defaults
const DEFAULT_EVO_MIN_SAMPLE_SIZE = 10
const DEFAULT_EVO_WINDOW_SIZE = 50
const DEFAULT_EVO_RETIRE_THRESHOLD = 0.2

const OUTCOME_MAP: Record<ReviewResult['outcome'], 'success' | 'cancel' | 'fail'> = {
  accepted: 'success',
  rejected: 'fail',
  inconclusive: 'cancel',
}

// ── Shared deps for extracted event handlers ──────────────────────────────

interface EvolutionEventDeps {
  bus: ReturnType<typeof asContractBus>
  reader: TraceReader
  spawner: JobSpawner | undefined
  proposals: ProposalStore | undefined
  statsStore: SkillStatsStore | undefined
  metaRepo: SkillMetaRepo | undefined
  ctxFactory: JobContextFactory | undefined
  state: PolicyState
  inflight: { current: number }
  autoRetireCfg: AutoRetireConfig
  collector: StatsCollector
  autoRetirer: AutoRetirer | null
  logger: { warn: (domain: string, msg: string) => void; info: (domain: string, msg: string) => void }
}

// ── Extracted event handlers ──────────────────────────────────────────────

async function handleTurnEvent(
  raw: unknown,
  deps: EvolutionEventDeps,
): Promise<void> {
  const env = raw as EventEnvelope<'turn.completed' | 'turn.failed', Record<string, unknown>>
  const e = env.payload
  if (!e || typeof e !== 'object') return
  const runId = typeof e.runId === 'string' ? e.runId : undefined
  if (!runId) return
  const decision = evaluateReviewPolicy(e as unknown as Parameters<typeof evaluateReviewPolicy>[0], deps.state)
  if (decision.kind === 'skip') return
  if (deps.inflight.current >= MAX_INFLIGHT) return
  if (!deps.spawner || !deps.proposals || !deps.statsStore || !deps.ctxFactory) return

  const run = await deps.reader.getRun(runId)
  if (!run) return

  const skillName = decision.kind === 'tier2' ? decision.skillName : undefined
  const stats = skillName ? await deps.statsStore.get(skillName) : null
  const tier = decision.kind === 'tier2' ? 'tier2' as const : 'tier0' as const

  const job: ReviewJob = { tier, runId, skillName, run, stats }

  deps.inflight.current++
  deps.bus.emit(createEvent('evolution.review.started', { runId, tier, skillName }))

  try {
    const result = await deps.spawner.run<ReviewJob, ReviewResult>({
      entry: require.resolve('./worker-entry'),
      job,
      ctx: deps.ctxFactory({ runId }),
      timeoutMs: REVIEW_TIMEOUT_MS,
    })
    await writeProposal(deps.proposals, result, runId)
    if (skillName) {
      await bumpStat(deps.statsStore, skillName, result.outcome)
      // Record outcome in sliding-window for auto-retire
      deps.collector.record(skillName, OUTCOME_MAP[result.outcome])
    }
    deps.bus.emit(createEvent('evolution.review.completed', {
      runId, tier, outcome: result.outcome, skillName,
    }))
  } catch (err) {
    deps.logger.warn('evolution', `review failed: ${String(err)}`)
    deps.bus.emit(createEvent('evolution.review.failed', {
      runId, tier, message: String(err),
    }))
  } finally {
    deps.inflight.current--
  }
}

async function handleReviewCompleted(
  raw: unknown,
  deps: EvolutionEventDeps,
): Promise<void> {
  const env = raw as EventEnvelope<'evolution.review.completed', EvolutionReviewCompletedV1>
  const e = env.payload
  const skillName = typeof e.skillName === 'string' ? e.skillName : undefined
  if (!skillName) return // tier0 review has no skill

  const stats = deps.statsStore ? await deps.statsStore.get(skillName) : null
  const snapshot = deps.collector.snapshot(skillName, stats)
  const decision = evaluateRetireRules(snapshot, deps.autoRetireCfg)

  if (decision.action === 'retire') {
    if (!deps.autoRetirer) {
      deps.logger.warn('evolution', `retire decision for ${skillName} but metaRepo unavailable — skipping`)
      return
    }
    await deps.autoRetirer.retire(skillName, decision.reason)
    return
  }

  // decision.action === 'healthy' → no-op
}

// ── Apply factory (extracted from defineExtension to satisfy max-lines-per-function) ──

function buildEvolutionApply(ctx: Parameters<typeof defineExtension>[0]['apply'] extends (arg: infer T) => unknown ? T : never) {
  const bus = asContractBus(ctx.bus)
  const reader = ctx.extensions.get<TraceReader>('trace.reader')
  const reg = ctx.extensions
  const spawner = reg.has('infra-services.job-spawner') ? reg.get<JobSpawner>('infra-services.job-spawner') : undefined
  const proposals = reg.has('infra-services.proposal-store') ? reg.get<ProposalStore>('infra-services.proposal-store') : undefined
  const statsStore = reg.has('infra-services.skill-stats-store') ? reg.get<SkillStatsStore>('infra-services.skill-stats-store') : undefined
  const metaRepo = reg.has('infra-services.skill-meta-repo') ? reg.get<SkillMetaRepo>('infra-services.skill-meta-repo') : undefined
  const ctxFactory = reg.has('infra-services.job-context-factory')
    ? reg.get<JobContextFactory>('infra-services.job-context-factory')
    : undefined
  const state: PolicyState = { turnsSinceReview: 0, errorBurst: [], skillRunsSeen: {} }

  // Read auto-retire config with defaults
  const ar = ((ctx.config as Record<string, unknown>).evolution as Record<string, unknown> | undefined)?.autoRetire as Record<string, unknown> | undefined
  const autoRetireCfg: AutoRetireConfig = {
    enabled: (ar?.enabled as boolean) ?? true,
    minSampleSize: (ar?.minSampleSize as number) ?? DEFAULT_EVO_MIN_SAMPLE_SIZE,
    windowSize: (ar?.windowSize as number) ?? DEFAULT_EVO_WINDOW_SIZE,
    retireThreshold: (ar?.retireThreshold as number) ?? DEFAULT_EVO_RETIRE_THRESHOLD,
  }

  // Instantiate stats-driven auto-retire components
  const collector = new StatsCollector(autoRetireCfg.windowSize)
  const autoRetirer = metaRepo
    ? new AutoRetirer(ctx.paths, bus, metaRepo, ctx.logger)
    : null

  const deps: EvolutionEventDeps = {
    bus, reader, spawner, proposals, statsStore, metaRepo, ctxFactory,
    state,
    inflight: { current: 0 },
    autoRetireCfg,
    collector,
    autoRetirer,
    logger: ctx.logger,
  }

  return {
    slash: [slashEvolution],
    subscribe: {
      'turn.completed': (raw: unknown) => { void handleTurnEvent(raw, deps) },
      'turn.failed': (raw: unknown) => { void handleTurnEvent(raw, deps) },
      'evolution.review.completed': (raw: unknown) => { void handleReviewCompleted(raw, deps) },
    },

    rpc: {
      'evolution.listProposals': async (params: unknown) => {
        if (!proposals) throw new Error('proposal-store not available')
        const p = params as { limit?: number } | undefined
        const list = await proposals.list({ limit: p?.limit ?? EVO_DEFAULT_LIMIT })
        return { proposals: list.map(e => ({ id: e.id, tier: e.tier, outcome: e.outcome, skillName: e.skillName, reasoning: e.reasoning, createdAt: e.createdAt })) }
      },
      'evolution.promote': async (params: unknown) => {
        if (!proposals) throw new Error('proposal-store not available')
        const p = params as { id?: string } | undefined
        if (!p?.id) throw new Error('id is required')

        // Look up the proposal to get skillProposed
        const list = await proposals.list({ limit: 100 })
        const proposal = list.find(e => e.id === p.id)
        if (!proposal) throw new Error(`proposal ${p.id} not found`)

        let filePath: string | undefined
        if (proposal.skillProposed) {
          const result = promoteToSkill({ proposal, skillsDir: ctx.paths.skills.agent })
          filePath = result.filePath
        }

        await proposals.markAccepted(p.id, filePath ? { filePath } : undefined)

        // Emit reload event
        bus.emit(createEvent('skills.reload-requested', {
          reason: 'evolution.promote',
          source: p.id,
        }))

        return { status: 'promoted', filePath }
      },
      'evolution.discard': async (params: unknown) => {
        if (!proposals) throw new Error('proposal-store not available')
        const p = params as { id?: string } | undefined
        if (!p?.id) throw new Error('id is required')
        await proposals.markRejected(p.id)
        return { status: 'discarded' }
      },
      'evolution.stats': async (_params: unknown) => {
        if (!statsStore) throw new Error('skill-stats-store not available')
        const list = await statsStore.list()
        return { skills: list }
      },
    },
  }
}

export const cliManifest: CliManifest = {
  name: 'evolution',
  description: 'Review and manage evolution proposals',
  usage: [
    '  my-agent evolution list [--limit N]',
    '  my-agent evolution promote <id>',
    '  my-agent evolution discard <id>',
    '  my-agent evolution stats',
  ].join('\n'),
  handler: async (argv, ctx) => {
    const sub = argv[0]
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- CLI subcommand dispatch with default catch-all
    switch (sub) {
      case 'list': {
        const limitIdx = argv.indexOf('--limit')
        const limit = limitIdx >= 0 ? parseInt(argv[limitIdx + 1]!, 10) : EVO_DEFAULT_LIMIT
        const result = await ctx.rpc('evolution.listProposals', { limit })
        const data = result as { proposals: Array<{ id: string; tier: string; outcome: string; skillName?: string; reasoning: string; createdAt: number }> }
        if (data.proposals.length === 0) {
          ctx.out('No proposals yet.\n')
          return
        }
        for (const p of data.proposals) {
          const date = new Date(p.createdAt).toISOString().slice(0, 10)
          ctx.out(`${p.id.slice(0, EVO_COLUMNS.id).padEnd(EVO_COLUMNS.idPad)} ${p.tier.padEnd(EVO_COLUMNS.tier)} ${p.outcome.padEnd(EVO_COLUMNS.outcome)} ${(p.skillName ?? '-').padEnd(EVO_COLUMNS.skill)} ${date}\n`)
        }
        return
      }
      case 'promote': {
        if (!argv[1]) { ctx.err('missing <id>\n'); process.exit(2) }
        await ctx.rpc('evolution.promote', { id: argv[1] })
        ctx.out(`Proposal ${argv[1]} promoted.\n`)
        return
      }
      case 'discard': {
        if (!argv[1]) { ctx.err('missing <id>\n'); process.exit(2) }
        await ctx.rpc('evolution.discard', { id: argv[1] })
        ctx.out(`Proposal ${argv[1]} discarded.\n`)
        return
      }
      case 'stats': {
        const result = await ctx.rpc('evolution.stats')
        const data = result as { skills: Array<{ name: string; totalRuns: number; successfulRuns: number; lastReviewedAt: number }> }
        if (data.skills.length === 0) {
          ctx.out('No skill stats yet.\n')
          return
        }
        for (const s of data.skills) {
          const rate = s.totalRuns > 0 ? (s.successfulRuns / s.totalRuns * 100).toFixed(0) + '%' : '-'
          ctx.out(`${s.name.padEnd(EVO_COLUMNS.name)} ${String(s.totalRuns).padEnd(EVO_COLUMNS.runs)} ${rate.padEnd(EVO_COLUMNS.rate)} ${new Date(s.lastReviewedAt).toISOString().slice(0, 10)}\n`)
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

export default () =>
  defineExtension({
    name: 'evolution',
    enforce: 'normal',
    dependsOn: ['trace'],

    apply: (ctx) => buildEvolutionApply(ctx),
  })
