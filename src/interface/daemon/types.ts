import type { Kernel } from '../../kernel/kernel'
import type { ExtensionBuilder } from '../../kernel/define-extension'

export interface DaemonOptions {
  agentId: string                    // required — bootstrap anchor
  agentsRoot?: string                 // default ~/.my-agent/profiles
  socketPath?: string                  // default ${agentsRoot}/${agentId}/daemon.sock (explicit only for tests)
  transport?: 'unix' | 'inmem'         // default 'unix'; 'inmem' for tests
  identity?: string                    // default from env
  extraExtensions?: ExtensionBuilder[] // test hook
}

export interface DaemonHandle {
  kernel: Kernel
  agentDir: string                   // resolved absolute path, for test assertions
  socketPath: string
  stop: () => Promise<void>            // idempotent
}
