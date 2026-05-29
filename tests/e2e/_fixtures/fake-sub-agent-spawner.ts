import type { JobSpawner, JobContext, ChatCompleteRequest, ChatCompleteResponse } from '../../../src/application/ports/job-spawner'
import { runMiniTurnLoop } from '../../../src/extensions/sub-agent/mini-turn-loop'
import type { SubAgentDescriptor } from '../../../src/extensions/sub-agent/types'

export type FakeWorkerHandler = (
  job: { descriptor: SubAgentDescriptor; userPrompt: string; toolSchemas: Array<{ name: string; description: string; parameters: Record<string, unknown> }> },
  ctx: JobContext,
) => Promise<{ finalText: string; usage: { input: number; output: number }; toolCallCount: number; rounds: number; finishReason: string }>

/**
 * In-memory JobSpawner that runs the worker handler synchronously
 * (no process spawn). Used for fast e2e behavior tests.
 */
export class FakeSubAgentSpawner implements JobSpawner {
  private handler: FakeWorkerHandler

  constructor(handler?: FakeWorkerHandler) {
    this.handler = handler ?? this.defaultHandler
  }

  setHandler(h: FakeWorkerHandler) {
    this.handler = h
  }

  private defaultHandler: FakeWorkerHandler = async (job, ctx) => {
    return runMiniTurnLoop({
      descriptor: job.descriptor,
      userPrompt: job.userPrompt,
      subSessionId: 'fake-sub-session',
      subTurnId: 'fake-sub-turn',
      parentTurnId: 'fake-parent-turn',
      chatComplete: ctx.chatComplete!,
      dispatchTool: ctx.dispatchTool!,
      toolSchemas: job.toolSchemas,
      log: ctx.log ?? (() => {}),
    })
  }

  async run<TJob, TResult>(opts: {
    entry: string
    job: TJob
    ctx: JobContext
    timeoutMs?: number
  }): Promise<TResult> {
    const job = opts.job as any
    const result = await this.handler(job, opts.ctx)
    return result as unknown as TResult
  }
}
