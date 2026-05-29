import type { ReviewJob, ReviewResult } from './types'
import type { JobContext } from '../../application/ports/job-spawner'
import { buildPrompt } from './prompt-templates'
import { parseVerdict } from './parse-verdict'
import { runWorker } from '../../infrastructure/jobs/spawn-worker-runtime'

export async function handle(job: ReviewJob, ctx: JobContext): Promise<ReviewResult> {
  const prompt = buildPrompt(job)
  const purpose = job.tier === 'tier0' ? 'evolution.review.tier0' : 'evolution.review.tier2'
  try {
    const { content } = await ctx.invoke({
      purpose,
      messages: prompt.messages,
      maxTokens: prompt.maxTokens,
    })
    return parseVerdict(content, job)
  } catch (err) {
    ctx.log?.('error', `LLM invoke failed: ${String(err)}`)
    throw err
  }
}

if (process.env.JOB_MODE === 'spawn' && process.env.JOB_WORKER_ENTRY === '1') {
  runWorker((job, ctx) => handle(job as ReviewJob, ctx))
    .catch((err: unknown) => {
      process.stderr.write(`runWorker failed: ${String(err)}\n`)
      process.exit(1)
    })
}
