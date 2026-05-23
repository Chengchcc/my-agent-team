import { createEvent } from './event-envelope'
import type { WidgetName, WidgetPayloadFor } from './widget-payload-map'
import { nanoid } from 'nanoid'

export interface InlineBlockV1 {
  readonly type: 'tui.inline-block'
  readonly v: 1
  readonly sessionId: string
  readonly blockId: string
  readonly widget: WidgetName
  readonly payload: unknown          // serialized; emitter-side typed via emitInlineBlock
  readonly mode: 'append' | 'replace'
  readonly ts: number
}

/**
 * Emit a typed inline-block event on the contract bus.
 * WidgetName + payload are type-checked against WidgetPayloadMap.
 */
export function emitInlineBlock<W extends WidgetName>(
  bus: { emit(event: string, payload: unknown): void },
  args: {
    sessionId: string
    widget: W
    payload: WidgetPayloadFor<W>
    blockId?: string
    mode?: 'append' | 'replace'
  },
): void {
  const blockId = args.blockId ?? `inline-${nanoid()}`
  const event: InlineBlockV1 = {
    type: 'tui.inline-block',
    v: 1,
    sessionId: args.sessionId,
    blockId,
    widget: args.widget,
    payload: args.payload as unknown,
    mode: args.mode ?? 'append',
    ts: Date.now(),
  }
  bus.emit('tui.inline-block', createEvent('tui.inline-block', event, {
    sessionId: args.sessionId,
  }))
}
