import { defineExtension } from "../../kernel/define-extension"
import { slashEvolution } from "./slash/slash-evolution"
import { createEvent } from '../../application/contracts'
import { asContractBus } from '../../application/event-bus/contract-bus'
import type { EventEnvelope } from '../../application/contracts'
import { evaluateReviewPolicy, type PolicyState } from './policy'
import { bumpStat } from './skill-stats'
import { writeProposal } from './proposal-writer'
import type { JobSpawner } from '../../application/ports/job-spawner'
import type { TraceReader } from '../../application/ports/trace-checkpointer'
import type { ProposalStore } from '../../application/ports/proposal-store'
import type { SkillStatsStore } from '../../application/ports/skill-stats-store'
import type { ReviewJob, ReviewResult } from './types'
import type { JobContextFactory } from '../infra-services/job-context-factory'
import type { CliManifest } from '../../cli/cli-types'
import type { AssertHasCliManifest } from '../../cli/assert-cli-bearing'

const REVIEW_TIMEOUT_MS = 120_000
const MAX_INFLIGHT = 1
const EVO_COLUMNS = { id: 12, idPad: 14, tier: 8, outcome: 14, skill: 16, runs: 6, rate: 6, name: 24 } as const
const EVO_DEFAULT_LIMIT = 20

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

    apply: (ctx) => {
      const bus = asContractBus(ctx.bus)
      const reader = ctx.extensions.get<TraceReader>('trace.reader')
      const reg = ctx.extensions
      const spawner = reg.has('infra-services.job-spawner') ? reg.get<JobSpawner>('infra-services.job-spawner') : undefined
      const proposals = reg.has('infra-services.proposal-store') ? reg.get<ProposalStore>('infra-services.proposal-store') : undefined
      const statsStore = reg.has('infra-services.skill-stats-store') ? reg.get<SkillStatsStore>('infra-services.skill-stats-store') : undefined
      const ctxFactory = reg.has('infra-services.job-context-factory')
        ? reg.get<JobContextFactory>('infra-services.job-context-factory')
        : undefined
      const state: PolicyState = { turnsSinceReview: 0, errorBurst: [], skillRunsSeen: {} }
      let inflight = 0

      async function onTurnEvent(raw: unknown) {
        const env = raw as EventEnvelope<'turn.completed' | 'turn.failed', Record<string, unknown>>
        // Handle both envelope-wrapped and plain payload shapes
        const e = (env.payload && typeof env.payload === 'object'
          ? env.payload
          : raw) as Record<string, unknown>
        if (!e || typeof e !== 'object') return
        const runId = typeof e.runId === 'string' ? e.runId : undefined
        if (!runId) return
        const decision = evaluateReviewPolicy(e as unknown as Parameters<typeof evaluateReviewPolicy>[0], state)
        if (decision.kind === 'skip') return
        if (inflight >= MAX_INFLIGHT) return
        if (!spawner || !proposals || !statsStore || !ctxFactory) return

        const run = await reader.getRun(runId)
        if (!run) return

        const skillName = decision.kind === 'tier2' ? decision.skillName : undefined
        const stats = skillName ? await statsStore.get(skillName) : null
        const tier = decision.kind === 'tier2' ? 'tier2' as const : 'tier0' as const

        const job: ReviewJob = { tier, runId, skillName, run, stats }

        inflight++
        bus.emit(createEvent('evolution.review.started', { runId, tier, skillName }))

        try {
          const result = await spawner.run<ReviewJob, ReviewResult>({
            entry: require.resolve('./worker-entry'),
            job,
            ctx: ctxFactory({
              purpose: tier === 'tier0' ? 'evolution.review.tier0' : 'evolution.review.tier2',
              runId,
            }),
            timeoutMs: REVIEW_TIMEOUT_MS,
          })
          await writeProposal(proposals, result, runId)
          if (skillName) await bumpStat(statsStore, skillName, result.outcome)
          bus.emit(createEvent('evolution.review.completed', {
            runId, tier, outcome: result.outcome, skillName,
          }))
        } catch (err) {
          ctx.logger.warn('evolution', `review failed: ${String(err)}`)
          bus.emit(createEvent('evolution.review.failed', {
            runId, tier, message: String(err),
          }))
        } finally {
          inflight--
        }
      }

      return {
        slash: [slashEvolution],
        subscribe: {
          'turn.completed': onTurnEvent,
          'turn.failed': onTurnEvent,
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
            await proposals.markAccepted(p.id)
            return { status: 'promoted' }
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
    },
  })
