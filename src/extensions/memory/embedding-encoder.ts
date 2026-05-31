import type { EmbeddingEncoder } from './retrievers'
interface EncoderConfig { baseUrl: string; model: string; timeoutMs: number }
const DEFAULT: EncoderConfig = {
  baseUrl: process.env.MY_AGENT_MEMORY_EMBED_BASE_URL ?? 'http://localhost:11434',
  model:   process.env.MY_AGENT_MEMORY_EMBED_MODEL    ?? 'nomic-embed-text',
  timeoutMs: parseInt(process.env.MY_AGENT_MEMORY_EMBED_TIMEOUT_MS ?? '10000', 10),
}

export function createOllamaEncoder(cfg: Partial<EncoderConfig> = {}): EmbeddingEncoder {
  const c = { ...DEFAULT, ...cfg }
  return {
    async encode(text: string): Promise<number[]> {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), c.timeoutMs)
      try {
        const resp = await fetch(`${c.baseUrl}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: c.model, input: text }),
          signal: ctl.signal,
        })
        if (!resp.ok) throw new Error(`encode failed: ${resp.status}`)
        const data = (await resp.json()) as { embeddings: number[][] }
        const e = data.embeddings[0]
        if (!e) throw new Error('empty embedding')
        return e
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

