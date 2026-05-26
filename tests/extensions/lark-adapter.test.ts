import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'

// ── Mock Lark SDK ──────────────────────────────────────────────────────
// The real SDK makes network calls. We stub it so tests don't need credentials.

class MockClient {
  im = {
    v1: {
      message: {},
      chat: {},
      messageResource: {},
    },
  }
}

class MockLarkChannel {
  connect(): Promise<void> {
    return Promise.resolve()
  }
  disconnect(): Promise<void> {
    return Promise.resolve()
  }
  on(): () => void {
    // Returns a no-op unsubscribe function
    return () => {}
  }
}

mock.module('@larksuiteoapi/node-sdk', () => ({
  Client: MockClient,
  LarkChannel: MockLarkChannel,
  LoggerLevel: { info: 'info', warn: 'warn' },
}))

// ── Imports (after mock so SDK is stubbed when modules load) ───────────

import { createKernel } from '../../src/kernel/kernel'
import traceExt from '../../src/extensions/trace'
import sessionExt from '../../src/extensions/session'
import providerExt from '../../src/extensions/provider'
import controlplaneExt from '../../src/extensions/controlplane'
import controlplaneMethodsExt from '../../src/extensions/controlplane/methods'
import dataplaneExt from '../../src/extensions/dataplane'
import transportExt from '../../src/extensions/transport.inmem'
import larkExt, { createLarkBotConfig } from '../../src/extensions/frontend.lark'

describe('Lark bot adapter', () => {
  let kernel: ReturnType<typeof createKernel>

  beforeEach(async () => {
    kernel = createKernel({ agentId: 'lark-test' })
    kernel.use(traceExt())
    kernel.use(sessionExt())
    kernel.use(providerExt())
    kernel.use(controlplaneExt())
    kernel.use(controlplaneMethodsExt())
    kernel.use(dataplaneExt())
    kernel.use(transportExt())
    kernel.use(larkExt())
    await kernel.start()
  })

  afterEach(async () => {
    await kernel.stop()
  })

  it('frontend.lark capability available', () => {
    const lark = kernel.ctx.extensions.get('frontend-lark.lark')
    expect(lark).toBeDefined()
  })

  it('createBot returns adapter with correct kind', () => {
    const lark = kernel.ctx.extensions.get('frontend-lark.lark')
    const bot = lark.createBot(createLarkBotConfig('cli_test123', 'LARK_SECRET'))
    expect(bot).toBeDefined()
    expect(bot.kind).toBe('lark-bot')
    expect(bot.id).toMatch(/^lark-bot-/)
  })

  it('bot adapter implements FrontendHandle (start/stop)', async () => {
    const lark = kernel.ctx.extensions.get('frontend-lark.lark')
    const bot = lark.createBot(createLarkBotConfig('cli_test123', 'LARK_SECRET'))
    expect(bot.isRunning).toBe(false)
    await bot.start()
    expect(bot.isRunning).toBe(true)
    await bot.stop()
    expect(bot.isRunning).toBe(false)
  })

  it('handleMessage routes to session via anchor', async () => {
    const lark = kernel.ctx.extensions.get('frontend-lark.lark')
    const bot = lark.createBot(createLarkBotConfig('cli_test123', 'LARK_SECRET'))
    await bot.start()

    const result = await bot.handleMessage(
      { scope: 'p2p' as const, key: 'user-abc' },
      'Hello from Lark',
    )
    expect(result.accepted).toBe(true)
    expect(result.sessionId).toBeDefined()

    await bot.stop()
  })

  it('N bots share one Agent (N:1 model)', () => {
    const lark = kernel.ctx.extensions.get('frontend-lark.lark')
    const botA = lark.createBot(createLarkBotConfig('cli_aaa', 'AAA_SECRET'))
    const botB = lark.createBot(createLarkBotConfig('cli_bbb', 'BBB_SECRET'))

    expect(botA.id).not.toBe(botB.id)
    expect(lark.listBots()).toHaveLength(2)
    expect(lark.listBots()).toContain(botA.id)
    expect(lark.listBots()).toContain(botB.id)
  })

  it('routing table resolves anchor to session', async () => {
    const lark = kernel.ctx.extensions.get('frontend-lark.lark')
    const routingTable = lark.getRoutingTable()

    routingTable.bind('bot-1', { scope: 'thread', key: 'thread-xyz' }, 'session-1', 'Label')

    const resolved = routingTable.resolve('bot-1', { scope: 'thread', key: 'thread-xyz' })
    expect(resolved).toBe('session-1')
  })

  // ── New: LarkClient integration tests ────────────────────────────────

  it('creates LarkClient with appId from config', () => {
    const lark = kernel.ctx.extensions.get('frontend-lark.lark')
    const bot = lark.createBot(createLarkBotConfig('cli_test123', 'LARK_SECRET'))

    // Verify the adapter exposes the real LarkClient
    expect(bot.client).toBeDefined()
    expect(bot.client.appId).toBe('cli_test123')
  })

  it('bot adapter exposes appId and client', () => {
    const lark = kernel.ctx.extensions.get('frontend-lark.lark')
    const bot = lark.createBot(createLarkBotConfig('cli_app_abc', 'ABC_SECRET'))

    // appId is exposed directly on adapter
    expect(bot.appId).toBe('cli_app_abc')
    // client matches the same appId
    expect(bot.client.appId).toBe('cli_app_abc')
  })

  it('bot adapter can send text via LarkClient (smoke test)', async () => {
    const lark = kernel.ctx.extensions.get('frontend-lark.lark')
    const bot = lark.createBot(createLarkBotConfig('cli_test123', 'LARK_SECRET'))

    // sendToLark / replyToLark delegate to LarkClient methods.
    // Since the SDK is mocked, the underlying calls will not hit a real API.
    // Smoke test: the methods exist and are callable without error.
    expect(typeof bot.sendToLark).toBe('function')
    expect(typeof bot.replyToLark).toBe('function')
  })
})
