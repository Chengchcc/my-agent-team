import type { ReviewJob, ReviewResult } from './types'
import type { JobContext } from '../../application/ports/job-spawner'
import { buildPrompt } from './prompt-templates'
import { parseVerdict } from './parse-verdict'

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
    ctx.log?.('warn', `LLM invoke failed: ${String(err)}`)
    return parseVerdict('{}', job)
  }
}

if (process.env.JOB_MODE === 'spawn') {
  import('../../infrastructure/jobs/spawn-worker-runtime')
    .then(({ runWorker }) => runWorker((job, ctx) => handle(job as ReviewJob, ctx)))
    .catch((err: unknown) => {
      process.stderr.write(`runWorker failed: ${String(err)}\n`)
      process.exit(1)
    })
}
