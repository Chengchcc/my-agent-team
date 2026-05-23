import type { ComponentType } from 'react'
import type { KeyDispatcher } from '../input/key-dispatcher'

export interface OverlayDescriptor<Req = unknown, Res = unknown> {
  readonly name: string
  readonly Component: ComponentType<{
    request: Req
    respond: (response: Res) => void
    dismiss: () => void
    keyDispatcher?: KeyDispatcher
  }>
  readonly useManager: () => {
    pending: { request: Req; resolve: (r: Res) => void } | null
    respond: (r: Res) => void
    dismiss: () => void
  }
}

