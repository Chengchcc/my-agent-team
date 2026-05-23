import type { SessionHistoryPort } from '../ports/session-history'
import type { HistoryRecordV1 } from '../contracts'
import { compactHistory } from '../../domain/compact-history'
import { createEvent } from '../contracts'
import { asContractBus } from '../event-bus/contract-bus'

export interface Compactor {
  summarize(input: {
    sessionId: string
    messages: HistoryRecordV1[]
  }): Promise<{ summary: string; usage: { input: number; output: number } }>
}

export interface CompactSessionDeps {
  history: SessionHistoryPort
  compactor: Compactor
  bus: { emit(type: string, payload: unknown): void }
}

export interface CompactSessionInput {
  sessionId: string
  keepRecent?: number
}

export interface CompactSessionResult {
  ok: boolean
  removedCount: number
  summaryRecordId: string
  usage: { input: number; output: number }
  reason?: 'below_threshold' | 'summary_failed' | 'replace_failed'
}

const DEFAULT_KEEP_RECENT = 4

export async function compactSessionUsecase(
  input: CompactSessionInput,
  deps: CompactSessionDeps,
): Promise<CompactSessionResult> {
  const sessionId = input.sessionId
  const keepRecent = input.keepRecent ?? DEFAULT_KEEP_RECENT
  const msgs = deps.history.get(sessionId)

  if (msgs.length <= keepRecent) {
    return {
      ok: true, removedCount: 0, summaryRecordId: '',
      usage: { input: 0, output: 0 }, reason: 'below_threshold',
    }
  }

  const olderSlice = msgs.slice(0, msgs.length - keepRecent)

  let summary: string, usage: { input: number; output: number }
  try {
    const r = await deps.compactor.summarize({ sessionId, messages: olderSlice })
    summary = r.summary; usage = r.usage
  } catch {
    return {
      ok: false, removedCount: 0, summaryRecordId: '',
      usage: { input: 0, output: 0 }, reason: 'summary_failed',
    }
  }

  const out = compactHistory({ history: msgs, summary, keepRecent, sessionId })

  try {
    await deps.history.replace(sessionId, out.newHistory)
  } catch {
    return {
      ok: false, removedCount: 0, summaryRecordId: '',
      usage, reason: 'replace_failed',
    }
  }

  asContractBus(deps.bus).emit(createEvent('session.compacted', {
    sessionId,
    removedCount: out.removedCount,
    summaryRecordId: out.summaryRecord?.id ?? '',
    usage,
    ts: Date.now(),
  }, { sessionId }))

  return {
    ok: true,
    removedCount: out.removedCount,
    summaryRecordId: out.summaryRecord?.id ?? '',
    usage,
  }
}
