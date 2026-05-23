import type { ComponentType } from 'react'

export interface WidgetDescriptor<P = unknown> {
  readonly name: string
  readonly Component: ComponentType<{ payload: P }>
}
