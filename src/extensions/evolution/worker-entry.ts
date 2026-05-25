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
  const chunks: Buffer[] = []
  process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- worker entry fire-and-forget
  process.stdin.on('end', async () => {
    const job = JSON.parse(Buffer.concat(chunks).toString().trim().split('\n')[0]!) as ReviewJob
    try {
      const result = await handle(job, { invoke: async () => { throw new Error('spawn mode does not support LLM invoke') } })
      process.stdout.write(JSON.stringify(result) + '\n')
      process.exit(0)
    } catch (e) {
      process.stderr.write(String(e) + '\n')
      process.exit(1)
    }
  })
}
