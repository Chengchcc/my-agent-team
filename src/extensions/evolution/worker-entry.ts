import type { ReviewJob, ReviewResult } from './types'
import { buildPrompt } from './prompt-templates'
import { parseVerdict } from './parse-verdict'

export async function handle(job: ReviewJob): Promise<ReviewResult> {
  buildPrompt(job) // pre-compute prompt for when LLM call is wired
  // TODO: LLM call via ProviderInvoke — wired in follow-up
  // For now, return empty result to keep the pipeline functional
  return parseVerdict('{}', job)
}

if (process.env.JOB_MODE === 'spawn') {
  const chunks: Buffer[] = []
  process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- worker entry fire-and-forget
  process.stdin.on('end', async () => {
    const job = JSON.parse(Buffer.concat(chunks).toString().trim().split('\n')[0]!) as ReviewJob
    try {
      const result = await handle(job)
      process.stdout.write(JSON.stringify(result) + '\n')
      process.exit(0)
    } catch (e) {
      process.stderr.write(String(e) + '\n')
      process.exit(1)
    }
  })
}
