import type { KernelContext } from './kernel-context'
import type { SlashCommand } from '../application/slash'

/** Extension ordering phase within its dependency tier. */
export type Enforce = 'pre' | 'normal' | 'post'

/** Hook handler signature (simple function form). */
export type HookHandler = (...args: unknown[]) => unknown | Promise<unknown>

/** Object form of a hook handler with optional per-hook enforce/order overrides. */
export interface HookHandlerEntry {
  fn: HookHandler
  enforce?: Enforce // override extension-level enforce for this hook
  order?: number // fine-grained ordering within same enforce
}

/**
 * What an extension's apply() returns — its runtime contributions.
 * All keys on each channel are extension-local and must not collide between extensions.
 */
export interface ExtensionApplyResult {
  /** Capabilities consumed by other extensions via ctx.extensions.get(name) */
  provide?: Record<string, () => unknown>
  /** Hook handlers that Kernel wires into HookContainer (13 hooks) */
  hooks?: Record<string, HookHandler | HookHandlerEntry>
  /** Bus subscriptions — keyed by event name */
  subscribe?: Record<string, (event: unknown) => void | Promise<void>>
  /** RPC handlers exposed on the ControlPlane */
  rpc?: Record<string, (...args: unknown[]) => unknown | Promise<unknown>>
      slash?: SlashCommand[]
  /** Cleanup callback invoked on Kernel shutdown */
  dispose?: () => void | Promise<void>
}

/**
 * Frozen plain object returned by defineExtension.
 * Represents an extension definition — no state or instantiation here.
 */
export interface ExtensionBuilder {
  readonly name: string
  readonly enforce: Enforce
  readonly dependsOn: readonly string[]
  readonly apply: (ctx: KernelContext) => ExtensionApplyResult | Promise<ExtensionApplyResult>
}

/**
 * defineExtension — Vite-style extension factory.
 *
 * Returns a frozen ExtensionBuilder with:
 *   - enforce defaulting to 'normal'
 *   - dependsOn frozen array (defaults to empty)
 *   - apply function preserved as-is
 *
 * Example:
 *   export default () => defineExtension({
 *     name: 'memory',
 *     enforce: 'normal',
 *     dependsOn: ['trace'],
 *     apply: (ctx) => ({ provide: { ... }, hooks: { ... } }),
 *   })
 */
/** @public — extension authoring API */
function defineExtension(def: {
  name: string
  enforce?: Enforce
  dependsOn?: string[]
  apply: (ctx: KernelContext) => ExtensionApplyResult | Promise<ExtensionApplyResult>
}): ExtensionBuilder {
  return Object.freeze({
    name: def.name,
    enforce: def.enforce ?? 'normal',
    dependsOn: Object.freeze([...(def.dependsOn ?? [])]),
    apply: def.apply,
  })
}

export { defineExtension }
