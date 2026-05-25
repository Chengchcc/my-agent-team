import type { EventBus } from './event-bus'
import type { HookContainer } from './hook-container'
import type { ExtensionRegistry } from './extension-registry'
import type { RpcRegistry } from './rpc-registry'
import type { Logger } from '../application/ports/logger'
import type { AgentPaths } from '../infrastructure/paths/agent-paths'

export type { EventBus, HookContainer, RpcRegistry }
export type { Logger }

/**
 * Typed config accessor — provides safe, parse-at-boundary access to config values.
 */
export interface TypedConfig {
  /** Return the raw config record (for migrations or pass-through). */
  readonly raw: Record<string, unknown>
  /** Get a typed config value. The `parse` function should validate and return a default on failure. */
  get<T>(key: string, parse: (raw: unknown) => T): T
}

export interface KernelContext {
  readonly agentId: string
  readonly agentDir: string
  readonly paths: AgentPaths
  readonly extensions: ExtensionRegistry
  readonly bus: EventBus
  readonly hooks: HookContainer
  readonly rpc: RpcRegistry
  readonly clock: Clock
  readonly logger: Logger
  /** Typed config accessor. Prefer `config.get()` over `config.raw`. */
  readonly config: TypedConfig
}

export interface Clock {
  now(): number // unix ms
}
