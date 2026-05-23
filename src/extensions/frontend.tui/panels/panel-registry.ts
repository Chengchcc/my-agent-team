import React from 'react'
import type { PanelDescriptor } from './panel-types'
import { Footer } from '../views/chrome/Footer'
import { StreamingIndicator } from '../views/chrome/StreamingIndicator'

// Footer and StreamingIndicator read from useTuiStore internally for reactivity.
const panelFooter: PanelDescriptor = {
  name: 'panel.footer',
  slot: 'footer-left',
  Component: () => React.createElement(Footer),
}

const panelStreaming: PanelDescriptor = {
  name: 'panel.streaming-indicator',
  slot: 'footer-right',
  Component: () => React.createElement(StreamingIndicator),
}

export const PANELS: ReadonlyArray<PanelDescriptor> = [panelFooter, panelStreaming]
