import type { FrontendHandle } from '../../application/ports/frontend-handle'
import type { Transport } from '../../application/ports/transport'
import type { DataPlaneEvent } from '../../application/contracts'
import type { RoutingTable } from './routing-table'
import type { Anchor } from './anchor'
import { SessionClient } from '../frontend.tui/session-client'
import { SlashRegistry, registerBuiltinSlashCommands } from '../../application/slash'
import { TranscriptProjector } from '../frontend.tui/transcript/projector'
import { TurnCardController } from './internal/turn-card-controller'
import { addWorkingReaction, removeReaction } from './vendor/reaction'
import { tryHandleSlashCommand, setSlashHandlerLogger } from './internal/slash-handler'
import { createCardDeps } from './internal/card-deps'

const ROUTING_KEY_PREVIEW_CHARS = 8
const LOG_TEXT_PREVIEW_LEN = 50

// ── Lark SDK integration (self-contained within extension) ──
import { getLarkClient, type LarkClient } from './internal/client'
import { parseEventMessage } from './internal/message-parser'
import {
  handleCardAction,
  type CardHandlerDeps,
} from './internal/card-handler'
import { startLarkEventDispatcher, type EventHandlers } from './internal/event-dispatcher'
import type * as Lark from '@larksuiteoapi/node-sdk'
import type { RoutingContext } from './internal/types'

// ── Logger reference ──────────────────────────────────────────────────────

/** Logger reference set during extension apply — used by adapter start() */
let ctxLogger: { warn: (tag: string, msg: string) => void } = {
  warn: () => {},
}

/** Set the logger for LarkBotAdapter (called by extension apply()) */
export function setLarkBotAdapterLogger(logger: typeof ctxLogger): void {
  ctxLogger = logger
  setSlashHandlerLogger((tag, msg) => logger.warn(tag, msg))
}

// ── LarkBotAdapter ──────────────────────────────────────────────────────

export class LarkBotAdapter implements FrontendHandle {
  readonly id: string
  readonly kind = 'lark-bot' as const
  private transport: Transport
  private routingTable: RoutingTable
  private events: DataPlaneEvent[] = []
  private running = false
  private unsubscribeEvent: (() => void) | null = null
  private sessionClient: SessionClient
  private projector = new TranscriptProjector()
  private slashRegistry = new SlashRegistry()
  private sessionChatMap = new Map<string, string>()       // sessionId → chatId
  private turnControllers = new Map<string, TurnCardController>()
  private pendingControllers = new Map<string, TurnCardController>() // before sendInput
  private pendingReplyTo = new Map<string, string>()       // sessionId → user messageId
  private pendingReactions = new Map<string, string>()     // sessionId → reaction id

  // ── Real Lark SDK integration ──
  readonly appId: string
  private appSecret: string
  private larkClient: LarkClient
  private channel: Lark.LarkChannel | null = null
  private botOpenId = ''

  constructor(
    id: string,
    transport: Transport,
    routingTable: RoutingTable,
    appId: string,
    appSecret: string,
  ) {
    this.id = id
    this.transport = transport
    this.routingTable = routingTable
    this.appId = appId
    this.appSecret = appSecret
    this.larkClient = getLarkClient(appId, appSecret)
    this.sessionClient = new SessionClient(transport, appId)
    registerBuiltinSlashCommands(this.slashRegistry, {
      include: ['compact', 'help', 'cost', 'tools', 'daemon', 'cancel'],
    })
  }

  onAgentEvent(event: DataPlaneEvent): void {
    this.events.push(event)
  }

  async start(): Promise<void> {
    this.running = true
    // Subscribe to transport events for agent output
    this.unsubscribeEvent = this.transport.onEvent((event) => {
      if (event.target === this.id || !event.target) {
        this.onAgentEvent(event)
      }
      this.projector.pushDataplaneEvent(event)
      if (!event.sessionId) return

      // F3: move pending controller to active on turn.started
      if (event.type === 'turn.started') {
        const pending = this.pendingControllers.get(event.sessionId)
        if (pending) {
          this.turnControllers.set(event.sessionId, pending)
          this.pendingControllers.delete(event.sessionId)
        }
        return
      }

      // Stream events into active controller
      const ctrl = this.turnControllers.get(event.sessionId)
      if (ctrl) void ctrl.feed(event)

      // Terminal: finalize card + remove reaction
      if (event.type === 'turn.completed' || event.type === 'turn.failed') {
        const sid = event.sessionId
        const outcome = event.type === 'turn.failed'
          ? ((event.payload as Record<string, unknown>)?.outcome === 'aborted' ? 'interrupted' as const : 'error' as const)
          : 'done' as const
        const errMsg = outcome === 'error'
          ? String((event.payload as Record<string, unknown>)?.reason ?? 'unknown')
          : undefined
        if (ctrl) {
          void ctrl.finalize(outcome, errMsg)
            .finally(() => this.turnControllers.delete(sid))
        }
        const rid = this.pendingReactions.get(sid)
        const msgId = this.pendingReplyTo.get(sid)
        if (rid && msgId && this.channel) void removeReaction(this.channel, msgId, rid)
        this.pendingReactions.delete(sid)
        this.pendingReplyTo.delete(sid)
        this.pendingControllers.delete(sid)
      }
    })

    // Send hello
    await this.transport.sendRpc({
      jsonrpc: '2.0',
      id: `lark-hello-${Date.now()}`,
      method: 'hello',
      params: {
        frontendId: this.id,
        frontendKind: 'lark-bot',
        appVersion: '2.0.0',
        capabilities: { events: 16, methods: 24 },
      },
    })

    // Start the real Lark websocket event channel
    try {
      const eventHandlers = this.createEventHandlers()
      ctxLogger.warn('lark', `starting websocket channel for appId=${this.appId.slice(0, ROUTING_KEY_PREVIEW_CHARS)}...`)
      this.channel = startLarkEventDispatcher(
        this.appId,
        this.appSecret,
        eventHandlers,
        this.botOpenId,
        this.larkClient,
        { debug: (tag: string, msg: string) => ctxLogger.warn(tag, msg) },
      )
      ctxLogger.warn('lark', `websocket channel created for appId=${this.appId.slice(0, ROUTING_KEY_PREVIEW_CHARS)}...`)
    } catch (err) {
      ctxLogger.warn('lark', `Lark websocket channel failed to start: ${String(err)}`)
    }
  }

  async stop(): Promise<void> {
    this.running = false
    this.unsubscribeEvent?.()
    this.unsubscribeEvent = null
    // Close the Lark websocket channel
    if (this.channel) {
      try {
        this.channel.disconnect().catch(err => {
          ctxLogger.warn('lark', `channel disconnect failed: ${String(err)}`)
        })
      } catch { /* ignore close errors */ }
      this.channel = null
    }
    await this.transport.close()
  }

  // ── Message routing ──────────────────────────────────────────────────

  /** Route an incoming Lark message to a session, creating if needed */
  async handleMessage(
    anchor: Anchor,
    text: string,
    chatId?: string,
    messageId?: string,
  ): Promise<{ sessionId: string; accepted: boolean }> {
    ctxLogger.warn('lark', `handleMessage: scope=${anchor.scope} key=${anchor.key.slice(0, ROUTING_KEY_PREVIEW_CHARS)} text=${text.slice(0, LOG_TEXT_PREVIEW_LEN)}`)
    // Check if it's a slash command before creating a session
    if (chatId) {
      const handled = await tryHandleSlashCommand(
        { slashRegistry: this.slashRegistry, routingTable: this.routingTable, sessionClient: this.sessionClient, appId: this.appId },
        (cid, msg) => this.sendToLark(cid, msg),
        anchor, text, chatId,
      )
      if (handled) return handled
    }

    let sessionId = this.routingTable.resolve(this.appId, anchor)

    if (!sessionId) {
      if (anchor.scope === 'p2p') {
        // P2P sessions keyed by user for isolation
        sessionId = `lark-p2p-${anchor.key}`
        this.routingTable.bind(this.appId, anchor, sessionId)
      } else {
        // Create a new session for this anchor
        const createResult = await this.sessionClient.createSession(`Lark: ${anchor.scope}`)
        sessionId = createResult.sessionId
        this.routingTable.bind(
          this.appId,
          anchor,
          sessionId,
          `Lark: ${anchor.scope}:${anchor.key.slice(0, ROUTING_KEY_PREVIEW_CHARS)}`,
        )
      }
    }

    if (chatId) this.sessionChatMap.set(sessionId, chatId)
    if (messageId) this.pendingReplyTo.set(sessionId, messageId)

    // Add Typing reaction before input
    if (messageId && this.channel) {
      const rid = await addWorkingReaction(this.channel, messageId)
      if (rid) this.pendingReactions.set(sessionId, rid)
    }

    // F3: eager card open BEFORE sendInput. MUST be awaited so pendingControllers
    // is populated before turn.started fires (onTurnStart emits synchronously
    // inside sendInput, while open() requires a Lark network roundtrip).
    if (this.channel && chatId) {
      try {
        const ctrl = await TurnCardController.open(this.channel, chatId, messageId)
        if (!this.turnControllers.has(sessionId)) {
          this.pendingControllers.set(sessionId, ctrl)
        }
      } catch (err) {
        ctxLogger.warn('lark', `open card failed: ${String(err)}`)
      }
    }

    // Send input
    let result: { accepted?: boolean; queued?: boolean } = {}
    try {
      result = await this.sessionClient.sendInput(sessionId, text) as { accepted?: boolean; queued?: boolean }
    } catch { /* fallback */ }

    // F2: if queued, remove reaction + cleanup card
    if (result?.queued) {
      const rid = this.pendingReactions.get(sessionId)
      if (rid && messageId && this.channel) {
        void removeReaction(this.channel, messageId, rid)
      }
      this.pendingReactions.delete(sessionId)
      const pending = this.pendingControllers.get(sessionId)
      if (pending) {
        void pending.finalize('done').finally(() => this.pendingControllers.delete(sessionId))
      }
      if (chatId) {
        void this.sendToLark(chatId, '_当前回合还在进行,请使用 /cancel 后重发_').catch(() => {})
      }
    }

    return { sessionId, accepted: result?.accepted ?? true }
  }

  // ── Outgoing message delivery ────────────────────────────────────────

  /** Send a text message to a Lark chat */
  async sendToLark(
    chatId: string,
    content: string,
    msgType: 'text' | 'interactive' = 'text',
  ): Promise<string> {
    if (msgType === 'interactive') {
      return this.larkClient.sendMessage(chatId, content, 'interactive')
    }
    return this.larkClient.sendMessage(chatId, content, 'text')
  }

  /** Reply to a message in Lark */
  async replyToLark(
    messageId: string,
    content: string,
    msgType: 'text' | 'interactive' = 'text',
    replyInThread = false,
  ): Promise<string> {
    return this.larkClient.replyMessage(messageId, content, msgType, replyInThread)
  }

  // ── Card action handling ─────────────────────────────────────────────

  private createEventHandlers(): EventHandlers {
    const adapter = this
    return {
      handleNewTopic: async (data: unknown, ctx: RoutingContext) => {
        const parsed = parseEventMessage(data)
        const anchor = adapter.routingContextToAnchor(ctx)
        await adapter.handleMessage(anchor, parsed.content, ctx.chatId, ctx.messageId)
      },
      handleThreadReply: async (data: unknown, ctx: RoutingContext) => {
        const parsed = parseEventMessage(data)
        const anchor = adapter.routingContextToAnchor(ctx)
        await adapter.handleMessage(anchor, parsed.content, ctx.chatId, ctx.messageId)
      },
      handleCardAction: async (data: unknown) => {
        const cardBody = await handleCardAction(
          data as Record<string, unknown>,
          adapter.createCardDeps(),
        )
        return cardBody ?? undefined
      },
      isSessionOwner: (anchor: string) => {
        return (
          this.routingTable.resolve(adapter.appId, {
            scope: 'thread',
            key: anchor,
          }) !== null ||
          this.routingTable.resolve(adapter.appId, {
            scope: 'chat',
            key: anchor,
          }) !== null
        )
      },
    }
  }

  /** Convert RoutingContext (im/types) to Anchor (frontend.lark) */
  private routingContextToAnchor(ctx: RoutingContext): Anchor {
    return {
      scope: ctx.scope as Anchor['scope'],
      key: ctx.anchor,
    }
  }

  /** Build card-handler dependencies backed by Transport */
  private createCardDeps(): CardHandlerDeps {
    return createCardDeps(this.transport, this.sessionClient)
  }

  // ── Accessors ────────────────────────────────────────────────────────

  /** The real LarkClient backing this adapter */
  get client(): LarkClient {
    return this.larkClient
  }

  get routingEntries() {
    return this.routingTable.listByBot(this.appId)
  }

  get eventLog(): DataPlaneEvent[] {
    return [...this.events]
  }
  get isRunning(): boolean {
    return this.running
  }
}
