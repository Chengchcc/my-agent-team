import React from 'react'
import { Box } from 'ink'
import { PANELS } from './panel-registry'
import type { PanelSlot } from './panel-types'

function renderSlot(slot: PanelSlot) {
  const panels = PANELS.filter(p => p.slot === slot)
  return panels.map(p => React.createElement(p.Component, { key: p.name }))
}

export function PanelHost() {
  return (
    <Box flexDirection="column">
      <Box>{renderSlot('footer-right')}</Box>
      <Box>{renderSlot('footer-left')}</Box>
    </Box>
  )
}
