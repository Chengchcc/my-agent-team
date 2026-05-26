import { createTestKernel } from './kernel-helper'
import { defineExtension } from '../../src/kernel/define-extension'
import dataplaneExt from '../../src/extensions/dataplane'
import sessionExt from '../../src/extensions/session'
import traceExt from '../../src/extensions/trace'
import type { DataPlaneEvent } from '../../src/application/contracts'
import type { Kernel } from '../../src/kernel/kernel'
import type { ProviderChat, ChatResponseChunk, ChatResponse } from '../../src/application/ports/provider'

export interface MinimalKernel {
  kernel: Kernel
  capturedDpEvents: DataPlaneEvent[]
  capturedRawBusEvents: Array<{ type: string; payload: unknown }>
  /** Drive one turn directly via runTurnUsecase; resolves after turn.completed. */
  runTurn(sessionId: string, turnId: string, userInput: string): Promise<void>
}

export interface PresetChunks {
  textDeltas: string[]
  usage?: { input: number; output: number }
}

export async function bootMinimalKernel(opts: {
  presetChunks: PresetChunks
}): Promise<MinimalKernel> {
  const { presetChunks } = opts

  const fakeProvider: ProviderChat = {
    async *stream() {
      for (const delta of presetChunks.textDeltas) {
        yield { type: 'text' as const, delta }
      }
      if (presetChunks.usage) {
        yield { type: 'usage' as const, usage: { input: presetChunks.usage.input, output: presetChunks.usage.output } }
      }
      yield { type: 'done' as const }
    },
    async complete(): Promise<ChatResponse> {
      return { id: '', content: presetChunks.textDeltas.join(''), usage: { input: 0, output: 0 }, model: 'fake' }
    },
  }

  const capturedDpEvents: DataPlaneEvent[] = []
  const capturedRawBusEvents: Array<{ type: string; payload: unknown }> = []

  const providerInjector = defineExtension({
    name: 'test-provider-inject',
    enforce: 'pre',
    apply: () => ({ provide: { 'provider.llm': () => fakeProvider } }),
  })

  const captureExt = defineExtension({
    name: 'test-capture',
    enforce: 'post',
    dependsOn: ['dataplane'],
    apply: (ctx) => {
      ctx.bus.on('dataplane.event', (raw) => {
        capturedDpEvents.push(raw as DataPlaneEvent)
      })
      const origEmit = ctx.bus.emit.bind(ctx.bus)
      ;(ctx.bus as { emit: typeof origEmit }).emit = async (name, payload) => {
        capturedRawBusEvents.push({ type: name, payload })
        return origEmit(name, payload)
      }
      return {}
    },
  })

  const kernel = createTestKernel({
    extensions: [providerInjector, traceExt(), sessionExt(), dataplaneExt(), captureExt],
  })
  await kernel.start()

  return {
    kernel,
    capturedDpEvents,
    capturedRawBusEvents,
    async runTurn(sessionId, turnId, userInput) {
      const { runTurnUsecase, buildRunTurnDeps } = await import('../../src/application/usecases/run-turn')
      const deps = buildRunTurnDeps(kernel.ctx)
      await runTurnUsecase({ sessionId, turnId, userInput, frontendId: 'test' }, deps)
    },
  }
}
