import type { EventBus } from './event-bus'
import type { HookContainer } from './hook-container'
import type { ExtensionRegistry } from './extension-registry'
import type { RpcRegistry } from './rpc-registry'
import type { Logger } from '../application/ports/logger'
import type { AgentPaths } from '../infrastructure/paths/agent-paths'

export type { EventBus, HookContainer, RpcRegistry }
export type { Logger }

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
  readonly config: Record<string, unknown>
}

export interface Clock {
  now(): number // unix ms
}
