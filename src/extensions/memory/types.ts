import type { TraceRun } from '../../domain/trace/types'

export interface ExtractJob { runId: string; run: TraceRun }

export interface MemoryCandidate { text: string; weight: number; tags: string[] }

export interface ExtractResult { candidates: MemoryCandidate[] }
