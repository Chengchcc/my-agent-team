import type { DataPlaneEvent } from '../contracts'

/**
 * FrontendHandle —防腐层 (anti-corruption layer) interface.
 *
 * All frontends (TUI, Lark Bot, WebUI) implement this interface.
 * AgentCore/Kernel calls this without knowing TUI vs Lark details.
 * Frontends cannot import from domains/ or extensions/ internals —
 * they only use Transport (public API) and DataPlaneEvent types.
 */
interface FrontendHandle {
  readonly id: string
  readonly kind: 'tui' | 'lark-bot' | 'webui'

  /** Receive an event from the DataPlane */
  onAgentEvent(event: DataPlaneEvent): void

  /** Handle user question from Agent */
  onUserQuestion?(question: string, options: string[]): Promise<string>

  /** Handle permission request from Agent */
  onPermissionRequest?(toolName: string, summary: string): Promise<'allow' | 'deny'>

  /** Start the frontend */
  start(): Promise<void>

  /** Stop the frontend */
  stop(): Promise<void>
}

export type { FrontendHandle }
