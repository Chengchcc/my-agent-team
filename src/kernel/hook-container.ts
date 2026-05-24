import type { HookHandler, HookHandlerEntry, Enforce } from './define-extension'
import type { Logger } from '../application/ports/logger'

type HookMode = 'sequential' | 'parallel' | 'first-match'

/**
 * Per-hook configuration — which mode each of the 13 hooks uses.
 */
const HOOK_MODES: Record<string, HookMode> = {
  configureKernel: 'sequential',
  kernelReady: 'parallel',
  onTurnStart: 'sequential',
  transformPrompt: 'sequential',
  resolveTools: 'sequential',
  onToolCall: 'sequential',
  onLLMDelta: 'parallel',
  onTurnEnd: 'parallel',
  onTraceEmit: 'parallel',
  onIdentityChanged: 'parallel',
  onShutdown: 'sequential',
  serveControlMethod: 'first-match',
}

const ENFORCE_WEIGHT: Record<Enforce, number> = { pre: 0, normal: 1, post: 2 }

/**
 * Ordered handler entry after sorting.
 */
interface OrderedHandler {
  fn: HookHandler
  extensionName: string
  enforce: Enforce
  order: number
}

/**
 * HookContainer manages ordered hook handlers and dispatches hooks
 * according to their declared mode (sequential/parallel/first-match).
 */
class HookContainer {
  private handlers = new Map<string, OrderedHandler[]>()
  private logger: Logger | null = null

  setLogger(logger: Logger): void {
    this.logger = logger
  }

  /**
   * Register a hook handler from an extension.
   * Called during apply() phase.
   */
  register(
    extensionName: string,
    extensionEnforce: Enforce,
    hookName: string,
    handler: HookHandler | HookHandlerEntry,
  ): void {
    const entry: HookHandlerEntry = typeof handler === 'function'
      ? { fn: handler }
      : handler

    const ordered: OrderedHandler = {
      fn: entry.fn,
      extensionName,
      enforce: entry.enforce ?? extensionEnforce,
      order: entry.order ?? 0,
    }

    if (!this.handlers.has(hookName)) {
      this.handlers.set(hookName, [])
    }
    this.handlers.get(hookName)!.push(ordered)

    // Keep sorted: enforce weight → order → registerSeq (stable = push order)
    this.handlers.get(hookName)!.sort((a, b) => {
      if (a.enforce !== b.enforce) {
        return ENFORCE_WEIGHT[a.enforce] - ENFORCE_WEIGHT[b.enforce]
      }
      return a.order - b.order
    })
  }

  /**
   * Dispatch a hook. Mode determined by HOOK_MODES.
   */
  async dispatch(hookName: string, ...args: unknown[]): Promise<unknown> {
    const mode = HOOK_MODES[hookName] ?? 'parallel'
    const handlers = this.handlers.get(hookName) ?? []

    switch (mode) {
      case 'sequential': {
        let result: unknown = args[0]
        for (const h of handlers) {
          result = await h.fn(result, ...args.slice(1))
        }
        return result
      }
      case 'parallel': {
        const log = this.logger
        await Promise.all(handlers.map(h =>
          new Promise(resolve => { resolve(h.fn(...args)) }).catch(err => {
            const msg = `[HookContainer] ${hookName} handler from "${h.extensionName}" failed: ${err}`
            if (log) {
              log.warn('hook-container', msg)
            } else {
              console.warn(msg)
            }
          })
        ))
        return
      }
      case 'first-match': {
        for (const h of handlers) {
          const result = await h.fn(...args)
          if (result !== undefined && result !== null) {
            return result
          }
        }
        return undefined
      }
    }
  }

  /**
   * Check if any handlers are registered for a hook.
   */
  hasHandlers(hookName: string): boolean {
    return (this.handlers.get(hookName)?.length ?? 0) > 0
  }

  /**
   * Get handler count for a hook.
   */
  handlerCount(hookName: string): number {
    return this.handlers.get(hookName)?.length ?? 0
  }

  /**
   * Remove all handlers for a specific extension (used during dispose/replace).
   */
  unregisterExtension(extensionName: string): void {
    for (const [hookName, list] of this.handlers) {
      this.handlers.set(hookName, list.filter(h => h.extensionName !== extensionName))
    }
  }

  /**
   * Clear all handlers.
   */
  clear(): void {
    this.handlers.clear()
  }
}

export { HookContainer }
export type { OrderedHandler, HookMode }
