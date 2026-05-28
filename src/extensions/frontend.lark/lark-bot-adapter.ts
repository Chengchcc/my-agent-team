import type { FrontendHandle } from '../../application/ports/frontend-handle'
import type { Transport } from '../../application/ports/transport'
import type { DataPlaneEvent } from '../../application/contracts'
import type { Anchor } from '../../domain/anchor'
import { anchorToSessionId, MAIN_SESSION_ID } from '../../domain/anchor'
import type { RoutingTable } from './routing-table'
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

// ── Per-turn Lark context ──────────────────────────────────────────────

interface TurnLarkContext {
  chatId: string
  messageId?: string
  reactionId?: string
  controller?: TurnCardController
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
  private turnContext = new Map<string, TurnLarkContext>()          // turnId → context
  private pendingTurnContext = new Map<string, TurnLarkContext>()   // correlationId → context
  private turnControllers = new Map<string, TurnCardController>()   // turnId → controller
  private sessionDefaultChat = new Map<string, string>()            // sessionId → last known chatId

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
    channel?: Lark.LarkChannel,
    larkClientOverride?: LarkClient,
  ) {
    this.id = id
    this.transport = transport
    this.routingTable = routingTable
    this.appId = appId
    this.appSecret = appSecret
    this.channel = channel ?? null
    this.larkClient = larkClientOverride ?? getLarkClient(appId, appSecret)
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

      const turnId = (event as { turnId?: string }).turnId
      const sid = event.sessionId

      // turn.started: promote pending context → turnContext
      if (event.type === 'turn.started' && turnId) {
        const tCtx = this.findAndPromotePendingContext(turnId)
        if (tCtx?.controller) {
          this.turnControllers.set(turnId, tCtx.controller)
        } else if (this.channel) {
          // Queue-consumer turn: open fresh card for session's last known chat
          const chatId = this.sessionDefaultChat.get(sid)
          if (chatId) {
            TurnCardController.open(this.channel, chatId).then(ctrl => {
              this.turnControllers.set(turnId, ctrl)
              this.turnContext.set(turnId, { chatId })
            }).catch(() => {})
          }
        }
        return
      }

      // Stream events into active controller
      const ctrl = turnId ? this.turnControllers.get(turnId) : undefined
      if (ctrl) void ctrl.feed(event)

      // Terminal: finalize card + remove reaction
      if ((event.type === 'turn.completed' || event.type === 'turn.failed') && turnId) {
        this.handleTurnTerminal(event, turnId, ctrl)
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

    // Start the Lark websocket event channel (skip if already provided, e.g. in tests)
    if (!this.channel) {
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
    const label = anchorToSessionId(anchor).slice(0, ROUTING_KEY_PREVIEW_CHARS)
    ctxLogger.warn('lark', `handleMessage: kind=${anchor.kind} label=${label} text=${text.slice(0, LOG_TEXT_PREVIEW_LEN)}`)
    // Check if it's a slash command before creating a session
    if (chatId) {
      const handled = await tryHandleSlashCommand(
        { slashRegistry: this.slashRegistry, routingTable: this.routingTable, sessionClient: this.sessionClient, appId: this.appId },
        (cid, msg) => this.sendToLark(cid, msg),
        anchor, text, chatId,
      )
      if (handled) return handled
    }

    let sessionId = this.routingTable.lookup(this.appId, anchor)

    if (!sessionId) {
      if (anchor.kind === 'lark-p2p') {
        // One-agent-one-bot: p2p always routes to main session (guaranteed by session.kernelReady)
        sessionId = MAIN_SESSION_ID
      } else {
        // lark-group: each group gets its own session
        const createResult = await this.sessionClient.createSession(`Lark: ${anchor.kind}`)
        sessionId = createResult.sessionId
      }
      this.routingTable.bind(
        this.appId,
        anchor,
        sessionId,
        `Lark: ${anchor.kind}:${label}`,
      )
    }

    if (chatId) this.sessionDefaultChat.set(sessionId, chatId)

    // Stage per-turn Lark context with correlationId
    const correlationId = messageId ?? this.generateCorrelationId()
    const turnCtx: TurnLarkContext = { chatId: chatId!, messageId }
    this.pendingTurnContext.set(correlationId, turnCtx)

    // Add Typing reaction before input
    if (messageId && this.channel) {
      const rid = await addWorkingReaction(this.channel, messageId)
      if (rid) turnCtx.reactionId = rid
    }

    // F3: eager card open BEFORE sendInput
    if (this.channel && chatId) {
      try {
        const ctrl = await TurnCardController.open(this.channel, chatId, messageId)
        turnCtx.controller = ctrl
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
      if (turnCtx.reactionId && turnCtx.messageId && this.channel) {
        void removeReaction(this.channel, turnCtx.messageId, turnCtx.reactionId)
      }
      this.pendingTurnContext.delete(correlationId)
      if (turnCtx.controller) {
        void turnCtx.controller.finalize('done').catch(() => {})
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

  // ── Per-turn context management ──────────────────────────────────────

  private findAndPromotePendingContext(turnId: string): TurnLarkContext | undefined {
    for (const [corrId, ctx] of this.pendingTurnContext) {
      this.pendingTurnContext.delete(corrId)
      this.turnContext.set(turnId, ctx)
      return ctx
    }
    return undefined
  }

  private generateCorrelationId(): string {
    const radix = 36
    return `corr-${Date.now()}-${Math.random().toString(radix).slice(2)}`
  }

  private handleTurnTerminal(
    event: DataPlaneEvent,
    turnId: string,
    ctrl: TurnCardController | undefined,
  ): void {
    const outcome = event.type === 'turn.failed'
      ? ((event.payload as Record<string, unknown>)?.outcome === 'aborted' ? 'interrupted' as const : 'error' as const)
      : 'done' as const
    const errMsg = outcome === 'error'
      ? String((event.payload as Record<string, unknown>)?.reason ?? 'unknown')
      : undefined
    const tCtx = this.turnContext.get(turnId)
    if (ctrl) {
      void ctrl.finalize(outcome, errMsg)
        .finally(() => this.turnControllers.delete(turnId))
    }
    const rid = tCtx?.reactionId
    const msgId = tCtx?.messageId
    if (rid && msgId && this.channel) void removeReaction(this.channel, msgId, rid)
    this.turnContext.delete(turnId)
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
      isSessionOwner: (anchor: Anchor) => {
        return this.routingTable.lookup(adapter.appId, anchor) !== null
      },
    }
  }

  /** Convert RoutingContext to Anchor — the context already carries a canonical Anchor (PR G3). */
  private routingContextToAnchor(ctx: RoutingContext): Anchor {
    return ctx.anchor
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
