import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createKernel, type Kernel } from '../../src/kernel/kernel'
import { defineExtension } from '../../src/kernel/define-extension'
import evolutionExt from '../../src/extensions/evolution'
import type { TraceReader } from '../../src/application/ports/trace-checkpointer'
import type { JobSpawner } from '../../src/application/ports/job-spawner'
import type { ProposalStore } from '../../src/application/ports/proposal-store'
import type { SkillStatsStore } from '../../src/application/ports/skill-stats-store'
import type { JobContextFactory } from '../../src/extensions/infra-services/job-context-factory'
import type { TraceRun } from '../../src/domain/trace/types'
import type { TurnCompletedV1, TurnFailedV1 } from '../../src/application/contracts/session-events'
import { asContractBus } from '../../src/application/event-bus/contract-bus'
import type { EventEnvelope, EvolutionReviewStartedV1, EvolutionReviewCompletedV1 } from '../../src/application/contracts'

// ── Mock helpers ────────────────────────────────────────────────────────────────

function mockTraceRun(runId: string): TraceRun {
  return {
    id: runId,
    sessionId: 'test-session',
    startTime: Date.now() - 1000,
    endTime: Date.now(),
    model: 'test-model',
    turns: [],
    summary: {
      totalTurns: 1, totalToolCalls: 0, totalErrors: 0,
      totalTokens: {}, outcome: 'completed',
    },
  }
}

/** Mock trace extension that provides trace.reader returning a stub run for any id. */
function mockTraceExt() {
  return defineExtension({
    name: 'trace',
    enforce: 'pre',
    apply: () => ({
      provide: {
        'trace.reader': (): TraceReader => ({
          getRun: async (id) => mockTraceRun(id),
          listRecentSummaries: async () => [],
        }),
      },
    }),
  })
}

function makeTurnCompleted(opts?: Partial<TurnCompletedV1>): TurnCompletedV1 {
  return {
    sessionId: 's1',
    turnId: `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    runId: `run-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    usage: { input: 10, output: 5 },
    toolCallCount: 0,
    toolErrorCount: 0,
    activatedSkills: [],
    ...opts,
  }
}

function makeTurnFailed(opts?: Partial<TurnFailedV1>): TurnFailedV1 {
  return {
    sessionId: 's1',
    turnId: `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    runId: `run-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    outcome: 'error',
    stage: 'provider',
    reason: 'test failure',
    toolErrorCount: 1,
    ...opts,
  }
}

/** Mock infra-services that provides job-spawner, proposal-store, skill-stats-store. */
function mockInfraServicesExt() {
  return defineExtension({
    name: 'infra-services',
    enforce: 'post',
    apply: () => ({
      provide: {
        'infra-services.job-spawner': (): JobSpawner => ({
          async run(opts) {
            const job = opts.job as { tier?: string; skillName?: string }
            return {
              proposalId: 'mock-proposal-id',
              tier: (job.tier ?? 'tier0') as 'tier0' | 'tier2',
              outcome: 'inconclusive' as const,
              skillName: job.skillName,
              reasoning: 'mock review result',
            }
          },
        }),
        'infra-services.proposal-store': (): ProposalStore => ({
          async append() {},
          async list() { return [] },
          async markAccepted() {},
          async markRejected() {},
        }),
        'infra-services.skill-stats-store': (): SkillStatsStore => ({
          async get() { return null },
          async put() {},
          async list() { return [] },
        }),
        'infra-services.job-context-factory': (): JobContextFactory => (_opts) => ({
          invoke: async () => ({ content: '{}', usage: { input: 0, output: 0 } }),
          log: () => {},
        }),
      },
    }),
  })
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('evolution extension', () => {
  describe('registration metadata', () => {
    let kernel: Kernel

    beforeEach(async () => {
      kernel = createKernel({ agentId: 'evo-test', agentDir: '/tmp/evo-test-reg' })
      kernel.use(mockTraceExt())
      kernel.use(evolutionExt())
      await kernel.start()
    })

    afterEach(async () => {
      await kernel.stop()
    })

    it('has name "evolution", enforce "normal", dependsOn ["trace"]', () => {
      const ext = kernel.ctx.extensions.getExtension('evolution')
      expect(ext).toBeDefined()
      expect(ext!.name).toBe('evolution')
      expect(ext!.builder.enforce).toBe('normal')
      expect(ext!.builder.dependsOn).toEqual(['trace'])
    })
  })

  describe('event subscriptions', () => {
    let kernel: Kernel

    beforeEach(async () => {
      kernel = createKernel({ agentId: 'evo-test', agentDir: '/tmp/evo-test-sub' })
      kernel.use(mockTraceExt())
      kernel.use(evolutionExt())
      await kernel.start()
    })

    afterEach(async () => {
      await kernel.stop()
    })

    it('subscribes to turn.completed', () => {
      expect(kernel.ctx.bus.subscriberCount('turn.completed')).toBeGreaterThanOrEqual(1)
    })

    it('subscribes to turn.failed', () => {
      expect(kernel.ctx.bus.subscriberCount('turn.failed')).toBeGreaterThanOrEqual(1)
    })
  })

  describe('without infra-services', () => {
    let kernel: Kernel

    beforeEach(async () => {
      kernel = createKernel({ agentId: 'evo-test', agentDir: '/tmp/evo-test-noinfra' })
      kernel.use(mockTraceExt())
      kernel.use(evolutionExt())
      await kernel.start()
    })

    afterEach(async () => {
      await kernel.stop()
    })

    it('skips review pipeline gracefully — no review events emitted', async () => {
      const reviewEvents: unknown[] = []
      kernel.ctx.bus.on('evolution.review.started', (e) => reviewEvents.push(e))
      kernel.ctx.bus.on('evolution.review.completed', (e) => reviewEvents.push(e))
      kernel.ctx.bus.on('evolution.review.failed', (e) => reviewEvents.push(e))

      // Emit enough turn.completed to surpass MIN_TURNS_BETWEEN_REVIEWS (10)
      for (let i = 0; i < 15; i++) {
        await asContractBus(kernel.ctx.bus).emit('turn.completed', makeTurnCompleted({ runId: `run-${i}` }));
      }

      // Policy evaluation still runs but pipeline halts at the
      // "!spawner || !proposals || !statsStore" guard — no events.
      expect(reviewEvents.length).toBe(0)
    })

    it('turn.failed events are also silently skipped without infra-services', async () => {
      const reviewEvents: unknown[] = []
      kernel.ctx.bus.on('evolution.review.started', (e) => reviewEvents.push(e))
      kernel.ctx.bus.on('evolution.review.completed', (e) => reviewEvents.push(e))
      kernel.ctx.bus.on('evolution.review.failed', (e) => reviewEvents.push(e))

      // Emit turn.failed events — even with error bursts, no infra means no review
      for (let i = 0; i < 5; i++) {
        await asContractBus(kernel.ctx.bus).emit('turn.failed', makeTurnFailed({ runId: `run-fail-${i}` }));
      }

      expect(reviewEvents.length).toBe(0)
    })
  })

  describe('with full infra-services', () => {
    let kernel: Kernel

    beforeEach(async () => {
      kernel = createKernel({ agentId: 'evo-test', agentDir: '/tmp/evo-test-full' })
      kernel.use(mockTraceExt())
      kernel.use(evolutionExt())
      kernel.use(mockInfraServicesExt())
      await kernel.start()
    })

    afterEach(async () => {
      await kernel.stop()
    })

    it('emits evolution.review.started and evolution.review.completed when policy triggers via turn.completed', async () => {
      const started: EventEnvelope<'evolution.review.started', EvolutionReviewStartedV1>[] = []
      const completed: EventEnvelope<'evolution.review.completed', EvolutionReviewCompletedV1>[] = []

      kernel.ctx.bus.on('evolution.review.started', (e) => started.push(e as EventEnvelope<'evolution.review.started', EvolutionReviewStartedV1>))
      kernel.ctx.bus.on('evolution.review.completed', (e) => completed.push(e as EventEnvelope<'evolution.review.completed', EvolutionReviewCompletedV1>))

      // Emit 10 turn.completed — the 10th surpasses MIN_TURNS_BETWEEN_REVIEWS
      for (let i = 0; i < 10; i++) {
        await asContractBus(kernel.ctx.bus).emit('turn.completed', makeTurnCompleted({ runId: `run-${i}`, turnId: `turn-${i}` }));
      }

      expect(started.length).toBe(1)
      expect(started[0].type).toBe('evolution.review.started')
      expect(started[0].payload.tier).toBe('tier0')
      expect(started[0].payload.runId).toBeDefined()

      expect(completed.length).toBe(1)
      expect(completed[0].type).toBe('evolution.review.completed')
      expect(completed[0].payload.outcome).toBe('inconclusive')
      expect(completed[0].payload.tier).toBe('tier0')
    })

    it('emits evolution.review.started and evolution.review.completed when error burst triggers via turn.failed', async () => {
      const started: EventEnvelope<'evolution.review.started', EvolutionReviewStartedV1>[] = []
      const completed: EventEnvelope<'evolution.review.completed', EvolutionReviewCompletedV1>[] = []

      kernel.ctx.bus.on('evolution.review.started', (e) => started.push(e as EventEnvelope<'evolution.review.started', EvolutionReviewStartedV1>))
      kernel.ctx.bus.on('evolution.review.completed', (e) => completed.push(e as EventEnvelope<'evolution.review.completed', EvolutionReviewCompletedV1>))

      // Emit 3 turn.failed events to reach ERROR_BURST_THRESHOLD
      for (let i = 0; i < 3; i++) {
        await asContractBus(kernel.ctx.bus).emit('turn.failed', makeTurnFailed({ runId: `run-fail-${i}`, turnId: `turn-fail-${i}` }));
      }

      expect(started.length).toBe(1)
      expect(started[0].type).toBe('evolution.review.started')
      expect(started[0].payload.tier).toBe('tier0')

      expect(completed.length).toBe(1)
      expect(completed[0].type).toBe('evolution.review.completed')
    })

    it('limits inflight reviews to MAX_INFLIGHT (1)', async () => {
      const started: EventEnvelope<'evolution.review.started', EvolutionReviewStartedV1>[] = []

      kernel.ctx.bus.on('evolution.review.started', (e) => started.push(e as EventEnvelope<'evolution.review.started', EvolutionReviewStartedV1>))

      // Emit 10 turn.completed followed by 3 more — policy triggers once at turn #10,
      // then inflight=1 blocks subsequent triggers until the first completes.
      // Since bus.emit awaits all handlers synchronously, the review completes
      // before the next emit, so we get exactly 1 review started per 10-turn cycle.
      for (let i = 0; i < 20; i++) {
        await asContractBus(kernel.ctx.bus).emit('turn.completed', makeTurnCompleted({ runId: `run-${i}`, turnId: `turn-${i}` }));
      }

      // With 20 turn.completed events and MIN_TURNS_BETWEEN_REVIEWS=10,
      // policy fires at turn 10 and turn 20 → 2 reviews started.
      expect(started.length).toBe(2)
    })
  })
})
