export type SlashSource = 'builtin' | 'ext' | 'skill' | 'agent'

export interface SlashCommand {
  readonly name: string
  readonly description: string
  readonly source: SlashSource
  readonly aliases?: ReadonlyArray<string>
  readonly group?: string
  readonly visible?: boolean
  readonly resolve: (input: string, ctx: SlashContext) => Promise<SlashResolution>
}

export interface SlashContext {
  readonly sessionId: string
  readonly frontend: 'tui' | 'lark-bot' | 'webui'
  readonly userInputRaw: string
  readonly kernel: {
    rpc(method: string, params?: Record<string, unknown>): Promise<unknown>
  }
  readonly reply: {
    text(message: string): Promise<void> | void
    markdown?(message: string): Promise<void> | void
    notice?(message: string): Promise<void> | void
  }
  readonly ui?: {
    openSessionPicker?(): void
    appendDivider?(reason: 'clear' | 'compact'): void
    /** Switch to an existing session (detach old, attach target, render snapshot). */
    switchSession?(targetId: string): Promise<void>
    /** Create a new session and switch to it immediately. */
    newSession?(title?: string): Promise<{ sessionId: string }>
    /** Load sessions for picker display. */
    loadSessions?(): Promise<Array<{ id: string; title: string; isCurrent: boolean }>>
  }
}

export type SlashResolution =
  | { kind: 'submit-prompt'; text: string }
  | { kind: 'replace-input'; text: string }
  | { kind: 'handled'; message?: string }
  | { kind: 'render-widget'; widget: string; payload: unknown }

export interface ParsedSlash {
  command: SlashCommand
  argv: string[]
}

export interface SlashGroup {
  name: string
  description?: string
  commands: SlashCommand[]
}

export interface PromptSubmission {
  text: string
  requestedSkillName: string | null
}
