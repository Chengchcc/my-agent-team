import { describe, it, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createKernel } from '../../../src/kernel/kernel'
import { defineExtension } from '../../../src/kernel/define-extension'
import { createAgentPaths } from '../../../src/infrastructure/paths/agent-paths'
import { domainCore, memory, identity, skills, evolution, mcp, infraServices, transportInmem } from '../../../src/extensions/presets'
import type { EmbeddingEncoder } from '../../../src/extensions/memory/retrievers'

function spyEncoder(): EmbeddingEncoder & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async encode(text: string): Promise<number[]> {
      calls.push(text)
      return new Array(32).fill(0).map((_, i) => (text.length + i) / 37)
    },
  }
}

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, withTag: () => silentLogger } as const

describe('Memory encoder injection', () => {
  it('uses injected encoder and does not call fetch', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'enc-inj-'))
    const paths = createAgentPaths(path.dirname(agentDir), path.basename(agentDir))
    const spy = spyEncoder()

    let fetchCalled = false
    const origFetch = globalThis.fetch
    globalThis.fetch = async (...args: unknown[]) => {
      fetchCalled = true
      return new Response(JSON.stringify({ embeddings: [[0.1]] }), { status: 200 })
    }

    try {
      const kernel = createKernel({ agentId: 'test', agentDir, paths, logger: silentLogger })

      // Kernel-level fakes (same pattern as boot-kernel)
      const store = { get: async () => ({ identityStatus: 'ready' }), subscribe: () => () => {} }
      kernel.ctx.extensions.provideKernel('agent.store', store)
      kernel.ctx.extensions.provideKernel('agent.registry', { current: async () => store.get('test'), get: async () => store.get('test'), subscribe: () => () => {} })

      // Assembly: inject spy encoder via memory preset
      const presets = [
        ...domainCore, ...memory({ encoder: spy }), ...identity, ...skills(), ...evolution,
        ...mcp, ...infraServices, ...transportInmem,
      ].filter(b => b.name !== 'provider')
      for (const ext of presets) kernel.use(ext)

      // E2E provider fake (memory recall triggers extract which may need LLM)
      kernel.use(defineExtension({
        name: 'provider',
        enforce: 'pre',
        apply: () => ({ provide: { 'provider.llm': () => ({}) } }),
      }))

      await kernel.start()

      // Trigger a recall to exercise the encoder
      const recall = kernel.ctx.extensions.get('memory.recall') as { search: (q: string, o?: { limit?: number }) => Promise<unknown[]> }
      await recall.search('test query', { limit: 5 })

      // Assertions
      expect(spy.calls.length).toBeGreaterThan(0)
      expect(fetchCalled).toBe(false)

      await kernel.stop()
    } finally {
      globalThis.fetch = origFetch
      await rm(agentDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('priority: opts.encoder wins over agent.yaml embedding config', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'enc-pri-'))
    const paths = createAgentPaths(path.dirname(agentDir), path.basename(agentDir))
    const spy = spyEncoder()

    try {
      const kernel = createKernel({
        agentId: 'test',
        agentDir,
        paths,
        logger: silentLogger,
        config: {
          // agent.yaml embedding config that should be IGNORED when encoder is injected
          raw: { memory: { embedding: { baseUrl: 'http://should-not-be-used:9999', model: 'wrong-model' } } },
        },
      })

      const store = { get: async () => ({ identityStatus: 'ready' }), subscribe: () => () => {} }
      kernel.ctx.extensions.provideKernel('agent.store', store)
      kernel.ctx.extensions.provideKernel('agent.registry', { current: async () => store.get('test'), get: async () => store.get('test'), subscribe: () => () => {} })

      const presets = [
        ...domainCore, ...memory({ encoder: spy }), ...identity, ...skills(), ...evolution,
        ...mcp, ...infraServices, ...transportInmem,
      ].filter(b => b.name !== 'provider')
      for (const ext of presets) kernel.use(ext)

      kernel.use(defineExtension({
        name: 'provider',
        enforce: 'pre',
        apply: () => ({ provide: { 'provider.llm': () => ({}) } }),
      }))

      await kernel.start()
      const recall = kernel.ctx.extensions.get('memory.recall') as { search: (q: string, o?: { limit?: number }) => Promise<unknown[]> }
      await recall.search('priority test', { limit: 3 })

      expect(spy.calls.length).toBeGreaterThan(0)
      await kernel.stop()
    } finally {
      await rm(agentDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
