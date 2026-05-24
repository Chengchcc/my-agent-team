import { approxTokens, COMPACT_KEEP_RECENT, BUDGET_COMPACT_RATIO } from '../constants/compact'
import { compactSessionUsecase, type Compactor } from './compact-session'
import type { HistoryRecordV1 } from '../contracts'
import type { SessionHistoryPort } from '../ports/session-history'

export interface BudgetDeps {
  history: SessionHistoryPort
  compactor: Compactor
  bus: { emit(type: string, payload: unknown): void }
}

export interface BudgetCheckInput {
  compaction?: 'auto' | 'disabled'
}

class BudgetCompactError extends Error {
  constructor(
    message: string,
    public readonly ratio: number,
  ) {
    super(message)
    this.name = 'BudgetCompactError'
  }
}

async function compactOrFail(
  sessionId: string,
  deps: BudgetDeps,
  ratio: number,
): Promise<void> {
  let r = await compactSessionUsecase(
    { sessionId, keepRecent: COMPACT_KEEP_RECENT },
    { history: deps.history, compactor: deps.compactor, bus: deps.bus },
  )
  if (r.ok) return

  r = await compactSessionUsecase(
    { sessionId, keepRecent: COMPACT_KEEP_RECENT },
    { history: deps.history, compactor: deps.compactor, bus: deps.bus },
  )
  if (r.ok) return

  throw new BudgetCompactError(
    `<budget-error ratio="${ratio.toFixed(2)}" reason="compact_failed_twice">Context compaction failed. Please /clear or /compact manually.</budget-error>`,
    ratio,
  )
}

export async function reactiveCompactCheck(
  input: BudgetCheckInput,
  deps: BudgetDeps,
  historyMsgs: HistoryRecordV1[],
  tokenLimit: number,
  sessionId: string,
  turnId: string,
  bus: { emit(type: string, payload: unknown): void },
  logger: { info(d: string, m: string): void },
  toolErrorCount: number,
  totalUsage: { input: number; output: number },
  emitFailed: (bus: { emit(type: string, payload: unknown): void }, sid: string, tid: string, stage: string, err: Error, count?: number) => void,
): Promise<{ usage: { input: number; output: number }; success: boolean } | null> {
  if (input.compaction === 'disabled') return null
  const currentTokens = approxTokens(JSON.stringify(historyMsgs))
  if (currentTokens / tokenLimit <= BUDGET_COMPACT_RATIO) return null
  logger.info('turn', `reactive compact triggered (ratio ${(currentTokens / tokenLimit).toFixed(2)})`)
  try {
    await compactOrFail(sessionId, deps, currentTokens / tokenLimit)
    return null
  } catch (err) {
    if (err instanceof BudgetCompactError) {
      emitFailed(bus, sessionId, turnId, 'usecase_internal', err, toolErrorCount)
      return { usage: totalUsage, success: false }
    }
    throw err
  }
}
