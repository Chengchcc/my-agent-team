import type { JobContext } from '../../application/ports/job-spawner'
import type { SubAgentDescriptor } from './types'
import { runWorker } from '../../infrastructure/jobs/spawn-worker-runtime'
import { runMiniTurnLoop } from './mini-turn-loop'

interface SubAgentJobInput {
  descriptor: SubAgentDescriptor
  userPrompt: string
  subSessionId: string
  subTurnId: string
  parentTurnId: string
  agentDir: string
  toolSchemas: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
}

interface SubAgentJobResult {
  finalText: string
  usage: { input: number; output: number }
  toolCallCount: number
  rounds: number
  finishReason: string
}

export async function handle(job: SubAgentJobInput, ctx: JobContext): Promise<SubAgentJobResult> {
  if (!ctx.chatComplete) {
    throw new Error('sub-agent worker requires chatComplete in JobContext')
  }
  if (!ctx.dispatchTool) {
    throw new Error('sub-agent worker requires dispatchTool in JobContext')
  }

  return runMiniTurnLoop({
    descriptor: job.descriptor,
    userPrompt: job.userPrompt,
    subSessionId: job.subSessionId,
    subTurnId: job.subTurnId,
    parentTurnId: job.parentTurnId,
    chatComplete: ctx.chatComplete,
    dispatchTool: ctx.dispatchTool,
    toolSchemas: job.toolSchemas,
    log: ctx.log ?? (() => {}),
  })
}

if (process.env.JOB_MODE === 'spawn' && process.env.JOB_WORKER_ENTRY === '1') {
  runWorker((job, ctx) => handle(job as SubAgentJobInput, ctx))
    .catch((err: unknown) => {
      process.stderr.write(`sub-agent worker failed: ${String(err)}\n`)
      process.exit(1)
    })
}
