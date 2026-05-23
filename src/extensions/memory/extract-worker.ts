import type { ExtractJob, ExtractResult } from './types'
import { buildExtractPrompt } from './extract-prompt'

export async function handle(job: ExtractJob): Promise<ExtractResult> {
  buildExtractPrompt(job) // pre-compute prompt
  // TODO: LLM call via ProviderInvoke — wired in follow-up
  return { candidates: [] }
}

// parseCandidates will be re-added when LLM call is wired (follow-up PR)
// Parses #tag prefixed lines into MemoryCandidate blocks from LLM output.

if (process.env.JOB_MODE === 'spawn') {
  const chunks: Buffer[] = []
  process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- worker entry fire-and-forget
  process.stdin.on('end', async () => {
    const job = JSON.parse(Buffer.concat(chunks).toString().trim().split('\n')[0]!) as ExtractJob
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
