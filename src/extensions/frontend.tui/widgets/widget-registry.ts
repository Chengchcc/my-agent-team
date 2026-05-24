// Side-effect imports — load ext widget-payloads.ts so their declare module
// blocks merge into WidgetPayloadMap. Required because:
//   1. tsc only merges declarations of files in program
//   2. tsconfig include catches them by default, but we don't rely on it
//   3. A19.7 enforces this list stays in sync with payload files
//
// verbatimModuleSyntax preserves these imports verbatim — they hit Bun's
// loader at runtime, execute zero code (payloads are type-only modules).
// Per-ext side-effect imports go here (W7.x uncomments each):
import '../../memory/widget-payloads'
import '../../trace/widget-payloads'
import '../../tools/widget-payloads'
import '../../evolution/widget-payloads'
import '../../session-mode/widget-payloads'

import type { WidgetName, WidgetPayloadFor } from '../../../application/contracts/widget-payload-map'
import type { WidgetDescriptor } from './widget-types'
import { widgetTodoList } from './impls/widget-todo-list'
import { widgetTraceShow } from './impls/widget-trace-show'
import { widgetTraceList } from './impls/widget-trace-list'
import { widgetMemoryList } from './impls/widget-memory-list'
import { widgetEvolutionProposals } from './impls/widget-evolution-proposals'
import { widgetPlanProposal } from './impls/widget-plan-proposal'

type WidgetMap = { [W in WidgetName]: WidgetDescriptor<WidgetPayloadFor<W>> }

/** No cast: tsc enforces all WidgetName keys are present. */
const WIDGETS: WidgetMap = {
  'skills.todo-list': widgetTodoList,
  'trace.show': widgetTraceShow,
  'trace.list': widgetTraceList,
  'memory.list': widgetMemoryList,
  'evolution.proposals': widgetEvolutionProposals,
  'plan.proposal': widgetPlanProposal,
}

export function lookupWidget(name: string): WidgetDescriptor | null {
  return (WIDGETS as Record<string, WidgetDescriptor>)[name] ?? null
}
