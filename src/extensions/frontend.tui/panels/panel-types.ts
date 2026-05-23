import type { ComponentType } from 'react'

export type PanelSlot = 'footer-left' | 'footer-right'

export interface PanelDescriptor {
  readonly name: string
  readonly slot: PanelSlot
  readonly Component: ComponentType
}
