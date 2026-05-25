import type { ExtractJob, ExtractResult, MemoryCandidate } from './types'
import type { JobContext } from '../../application/ports/job-spawner'
import { buildExtractPrompt } from './extract-prompt'

const DEFAULT_WEIGHT = 1

export async function handle(job: ExtractJob, ctx: JobContext): Promise<ExtractResult> {
  const prompt = buildExtractPrompt(job)
  try {
    const { content } = await ctx.invoke({
      purpose: 'memory.extract',
      messages: prompt.messages,
      maxTokens: prompt.maxTokens,
    })
    return { candidates: parseCandidates(content) }
  } catch (err) {
    ctx.log?.('error', `LLM invoke failed: ${String(err)}`)
    throw err
  }
}

/** Parses `#tag1 #tag2\nbody` paragraphs into candidates. */
export function parseCandidates(raw: string): MemoryCandidate[] {
  const out: MemoryCandidate[] = []
  const blocks = raw.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)
  for (const block of blocks) {
    const lines = block.split('\n')
    const first = lines[0]!
    const tagMatches = [...first.matchAll(/#([a-z][a-z0-9-]*)/gi)].map(m => m[1]!.toLowerCase())
    if (tagMatches.length === 0) continue
    const strippedFirst = first.replace(/#[a-z][a-z0-9-]*/gi, '').trim()
    const bodyLines = strippedFirst
      ? [strippedFirst, ...lines.slice(1)]
      : lines.slice(1)
    const text = bodyLines.join('\n').trim()
    if (!text) continue
    out.push({ text, weight: DEFAULT_WEIGHT, tags: tagMatches })
  }
  return out
}

if (process.env.JOB_MODE === 'spawn') {
  import('../../infrastructure/jobs/spawn-worker-runtime')
    .then(({ runWorker }) => runWorker((job, ctx) => handle(job as ExtractJob, ctx)))
    .catch((err: unknown) => {
      process.stderr.write(`runWorker failed: ${String(err)}\n`)
      process.exit(1)
    })
}
