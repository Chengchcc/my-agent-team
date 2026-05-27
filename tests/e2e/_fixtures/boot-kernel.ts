import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createKernel } from '../../../src/kernel/kernel'
import { defineExtension } from '../../../src/kernel/define-extension'
import { domainCore, memory, identity, skills, evolution, mcp, infraServices, transportInmem, frontendLark } from '../../../src/extensions/presets'
import { createAgentPaths } from '../../../src/infrastructure/paths/agent-paths'
import { SessionClient } from '../../../src/extensions/frontend.tui/session-client'
import type { EventEnvelope } from '../../../src/application/contracts/event-envelope'
import type { Transport } from '../../../src/application/ports/transport'
import { E2EFakeProvider, type E2ETurn } from './e2e-fake-provider'
import { InMemoryAgentStore } from './in-memory-agent-store'

const silentLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  withTag: () => silentLogger,
} as const

export interface BootOpts {
  withLark?: boolean
  llmTurns?: E2ETurn[]
  frontendId?: string
}

export interface E2EHandle {
  kernel: ReturnType<typeof createKernel>
  client: SessionClient
  agentDir: string
  fakeLLM: E2EFakeProvider
  captured: EventEnvelope[]
  waitFor(predicate: (e: EventEnvelope) => boolean, timeoutMs?: number): Promise<EventEnvelope>
  stop(): Promise<void>
}

export async function bootE2E(opts: BootOpts = {}): Promise<E2EHandle> {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'e2e-'))
  const paths = createAgentPaths(path.dirname(agentDir), path.basename(agentDir))
  const captured: EventEnvelope[] = []
  const fakeLLM = new E2EFakeProvider()
  if (opts.llmTurns) fakeLLM.setTurns(opts.llmTurns)

  const kernel = createKernel({
    agentId: 'e2e',
    agentDir,
    paths,
    logger: silentLogger,
  })

  // ① Kernel-level fakes (MUST be before any kernel.use)
  kernel.ctx.extensions.provideKernel('agent.store', new InMemoryAgentStore('e2e'))

  // Presets in daemon order, minus real 'provider' (replaced below)
  const presets = [
    ...domainCore, ...memory, ...identity, ...skills(), ...evolution,
    ...mcp, ...infraServices, ...transportInmem,
    ...(opts.withLark ? frontendLark : []),
  ].filter(b => b.name !== 'provider')
  for (const ext of presets) kernel.use(ext)

  // E2E provider replacement (same name 'provider', enforce: 'pre')
  kernel.use(defineExtension({
    name: 'provider',
    enforce: 'pre',
    apply: () => ({ provide: { 'provider.llm': () => fakeLLM } }),
  }))

  // Event capture (last, enforce: 'post')
  kernel.use(defineExtension({
    name: 'e2e.capture',
    enforce: 'post',
    apply(ctx) {
      const orig = ctx.bus.emit.bind(ctx.bus)
      ctx.bus.emit = async (type: string, payload: unknown, o?: { sessionId?: string; turnId?: string }) => {
        const p = (payload as Record<string, unknown> | undefined) ?? {}
        const isEnv = typeof p.payload === 'object' && p.payload !== null &&
          typeof p.type === 'string' && typeof p.version === 'number'
        const inner = (p.payload ?? {}) as Record<string, unknown>
        captured.push({
          type,
          payload,
          sessionId: isEnv ? (p.sessionId ?? inner.sessionId) as string | undefined : o?.sessionId,
          turnId: isEnv ? (p.turnId ?? inner.turnId) as string | undefined : o?.turnId,
          ts: Date.now(), version: 1,
        } as EventEnvelope)
        return orig(type, payload, o)
      }
      return {}
    },
  }))

  await kernel.start()

  const transport = kernel.ctx.extensions.get('transport-inmem.transport') as Transport
  const client = new SessionClient(transport, opts.frontendId ?? 'e2e-tui')
  await client.sendRpc('hello', {
    frontendId: opts.frontendId ?? 'e2e-tui',
    frontendKind: 'tui',
    appVersion: '2.0.0-e2e',
    capabilities: { events: 16, methods: 24 },
  })

  return {
    kernel, client, agentDir, fakeLLM, captured,
    waitFor: (pred, ms = 2000) => waitForEvent(captured, pred, ms),
    stop: async () => { await kernel.stop(); await rm(agentDir, { recursive: true, force: true }) },
  }
}

async function waitForEvent(
  buf: EventEnvelope[],
  pred: (e: EventEnvelope) => boolean,
  ms: number,
): Promise<EventEnvelope> {
  const deadline = Date.now() + ms
  let cursor = 0
  while (Date.now() < deadline) {
    while (cursor < buf.length) {
      if (pred(buf[cursor]!)) return buf[cursor]!
      cursor++
    }
    await new Promise(r => setTimeout(r, 10))
  }
  console.error('[e2e.waitFor] timeout. tail events:',
    buf.slice(-20).map(e => `${e.type}(sid=${e.sessionId ?? 'n/a'})`).join(' | '))
  throw new Error(`waitFor timeout after ${ms}ms`)
}
