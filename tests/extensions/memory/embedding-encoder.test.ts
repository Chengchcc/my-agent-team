import { describe, it, expect, afterEach } from 'bun:test'
import { createOllamaEncoder } from '../../../src/extensions/memory/embedding-encoder'

function mockFetch(response: object, status = 200) {
  const orig = globalThis.fetch
  let url = ''
  let body = ''
  globalThis.fetch = async (u, opts) => {
    url = typeof u === 'string' ? u : String(u)
    body = (opts as RequestInit).body as string
    return new Response(JSON.stringify(response), { status })
  }
  return {
    restore: () => { globalThis.fetch = orig },
    get url() { return url },
    get body() { return body },
  }
}

describe('createOllamaEncoder', () => {
  afterEach(() => {
    // safety: restore fetch in case a test leaks
    // (mockFetch.restore handles this, but belt-and-suspenders)
  })

  it('uses explicit config over defaults', async () => {
    const encoder = createOllamaEncoder({ baseUrl: 'http://custom:9999', model: 'custom-model' })
    const spy = mockFetch({ embeddings: [[0.1, 0.2]] })

    await encoder.encode('hello')

    expect(spy.url).toBe('http://custom:9999/api/embed')
    expect(JSON.parse(spy.body)).toEqual({ model: 'custom-model', input: 'hello' })
    spy.restore()
  })

  it('falls back to default baseUrl when not overridden', async () => {
    const encoder = createOllamaEncoder()
    const spy = mockFetch({ embeddings: [[0.3]] })

    await encoder.encode('test')

    expect(spy.url).toBe('http://localhost:11434/api/embed')
    spy.restore()
  })

  it('falls back to default model when not overridden', async () => {
    const encoder = createOllamaEncoder()
    const spy = mockFetch({ embeddings: [[0.5]] })

    await encoder.encode('test')

    const parsed = JSON.parse(spy.body)
    expect(parsed.model).toBe('nomic-embed-text')
    spy.restore()
  })

  it('merges partial config with defaults', async () => {
    const encoder = createOllamaEncoder({ baseUrl: 'http://other:8080' })
    const spy = mockFetch({ embeddings: [[0.7]] })

    await encoder.encode('x')

    expect(spy.url).toBe('http://other:8080/api/embed')
    expect(JSON.parse(spy.body).model).toBe('nomic-embed-text')
    spy.restore()
  })

  it('returns embedding vector from response', async () => {
    const encoder = createOllamaEncoder()
    const expected = [0.1, 0.2, 0.3]
    const spy = mockFetch({ embeddings: [expected] })

    const result = await encoder.encode('x')

    expect(result).toEqual(expected)
    spy.restore()
  })

  it('throws on non-ok response', async () => {
    const encoder = createOllamaEncoder()
    const spy = mockFetch({ error: 'boom' }, 500)

    await expect(encoder.encode('x')).rejects.toThrow('encode failed: 500')
    spy.restore()
  })

  it('throws on empty embedding array', async () => {
    const encoder = createOllamaEncoder()
    const spy = mockFetch({ embeddings: [] })

    await expect(encoder.encode('x')).rejects.toThrow('empty embedding')
    spy.restore()
  })
})
