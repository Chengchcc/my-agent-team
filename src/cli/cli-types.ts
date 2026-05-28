/** A shell subcommand registered in the unified CLI. */
export interface CliManifest {
  readonly name: string
  readonly description: string
  readonly usage: string
  readonly handler: (argv: string[], ctx: CliRuntimeContext) => Promise<void>
}

import type { AgentStore } from '../application/ports/agent-store'

export interface CliRuntimeContext {
  readonly agentId: string
  readonly socketPath: string
  rpc(method: string, params?: unknown): Promise<unknown>
  out(s: string): void
  err(s: string): void
  readonly agentStore?: AgentStore
  readonly logger?: { info(tag: string, msg: string): void; warn(tag: string, msg: string): void; error(tag: string, msg: string): void }
  readonly paths?: { homeRoot: string; agentsRoot: string }
  /** Internal — closes RPC transport on dispose. Not for handler use. */
  readonly _dispose?: () => Promise<void>
}
