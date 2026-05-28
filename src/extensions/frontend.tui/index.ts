import { defineExtension } from '../../kernel/define-extension'
import { asContractBus } from '../../application/event-bus/contract-bus'
import type { Transport } from '../../application/ports/transport'
import type { Logger } from '../../application/ports/logger'
import type { FrontendHandle } from '../../application/ports/frontend-handle'
import type { DataPlaneEvent } from '../../application/contracts'
import type { SlashCommand } from '../../application/slash'
import { nanoid } from 'nanoid'
import { SessionClient } from './session-client'

/** Extension-contributed slash commands — populated in apply(), consumed by App.tsx */
export const extSlashCommands: SlashCommand[] = []

// ── TUIAdapter —防腐层 from Kernel to TUI ──

/**
 * TUIAdapter —防腐层providing Transport-based RPC and SessionClient creation.
 *
 * Uses Transport (public API) for JSON-RPC calls and event subscription.
 * Does NOT import any extension internals (memory, MCP, evolution, etc.).
 */
class TUIAdapter implements FrontendHandle {
  readonly id: string
  readonly kind = 'tui' as const
  private transport: Transport
  private events: DataPlaneEvent[] = []
  private running = false
  private unsubscribeEvent: (() => void) | null = null
  private logger?: Logger

  constructor(id: string, transport: Transport, logger?: Logger) {
    this.id = id
    this.transport = transport
    this.logger = logger
  }

  onAgentEvent(event: DataPlaneEvent): void {
    this.events.push(event)
  }

  async start(): Promise<void> {
    this.running = true
    // Subscribe to events from transport
    this.unsubscribeEvent = this.transport.onEvent((event) => {
      if (event.target === this.id || !event.target) {
        this.onAgentEvent(event)
      }
    })

    // Send hello to negotiate
    const response = await this.transport.sendRpc({
      jsonrpc: '2.0',
      id: 'hello-1',
      method: 'hello',
      params: {
        frontendId: this.id,
        frontendKind: 'tui',
        appVersion: '2.0.0',
        capabilities: { events: 16, methods: 24 },
      },
    })
    this.logger?.debug('tui', `Hello response: ${JSON.stringify(response)}`)
  }

  async stop(): Promise<void> {
    this.running = false
    this.unsubscribeEvent?.()
    this.unsubscribeEvent = null
    await this.transport.close()
  }

  /** Send an arbitrary RPC call */
  async sendRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const response = await this.transport.sendRpc({
      jsonrpc: '2.0',
      id: `rpc-${nanoid()}`,
      method,
      params,
    })
    return response?.result ?? null
  }

  /** Send user input to a session */
  async sendInput(sessionId: string, text: string): Promise<unknown> {
    const response = await this.transport.sendRpc({
      jsonrpc: '2.0',
      id: `input-${nanoid()}`,
      method: 'input.send',
      params: { sessionId, text },
    })
    return response
  }

  /** Attach to a session */
  async attachSession(sessionId?: string): Promise<unknown> {
    const response = await this.transport.sendRpc({
      jsonrpc: '2.0',
      id: `attach-${nanoid()}`,
      method: 'session.attach',
      params: sessionId ? { sessionId } : {},
    })
    return response
  }

  /** Detach from current session */
  async detachSession(sessionId: string): Promise<unknown> {
    const response = await this.transport.sendRpc({
      jsonrpc: '2.0',
      id: `detach-${nanoid()}`,
      method: 'session.detach',
      params: { sessionId },
    })
    return response
  }

  /** Resume a session (detach current + attach target) */
  async resumeSession(sessionId: string): Promise<unknown> {
    const response = await this.transport.sendRpc({
      jsonrpc: '2.0',
      id: `resume-${nanoid()}`,
      method: 'session.resume',
      params: { sessionId },
    })
    return response
  }

  /** List sessions for current profile */
  async listSessions(): Promise<unknown> {
    const response = await this.transport.sendRpc({
      jsonrpc: '2.0',
      id: `list-${nanoid()}`,
      method: 'session.list',
      params: {},
    })
    return response
  }

  /** Get the raw Transport */
  getTransport(): Transport {
    return this.transport
  }

  /** Create a SessionClient bound to this adapter's transport */
  createSessionClient(): SessionClient {
    return new SessionClient(this.transport, this.id)
  }

  get eventLog(): DataPlaneEvent[] {
    return [...this.events]
  }
  get isRunning(): boolean {
    return this.running
  }
}

export { TUIAdapter }

export default () =>
  defineExtension({
    name: 'frontend-tui',
    enforce: 'post',
    dependsOn: ['transport-inmem', 'controlplane', 'dataplane'],
    apply: (ctx) => {
      const bus = asContractBus(ctx.bus)
      // Collect extension slash commands for TUI picker
      extSlashCommands.length = 0
      extSlashCommands.push(...ctx.extensions.collectSlashCommands())

      return {
        provide: {
          'frontend-tui.tui': () => {
            // Transport is created by transport.inmem extension.
            // Use the full path 'transport-inmem.transport' per the
            // ExtensionRegistry capability lookup convention.
            const transport = ctx.extensions.get(
              'transport-inmem.transport',
            )
            return new TUIAdapter('tui-main', transport, ctx.logger)
          },
        },

        // Translate session.planWidget → tui.inline-block for TUI rendering
        subscribe: {
          'session.planWidget': (payload: unknown) => {
            const p = payload as { blockId: string; sessionId: string; status: string; payload: Record<string, unknown>; mode: string }
            void bus.emit('tui.inline-block', {
              blockId: p.blockId,
              widget: 'plan.proposal',
              payload: { ...p.payload, status: p.status },
              mode: p.mode,
            })
          },
          'skills.reloaded': () => {
            extSlashCommands.length = 0
            extSlashCommands.push(...ctx.extensions.collectSlashCommands())
          },
        },
      }
    },
  })
