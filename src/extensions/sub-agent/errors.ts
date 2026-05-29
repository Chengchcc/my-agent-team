export class SubAgentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'SubAgentError'
  }
}

export class ToolNotAllowedError extends SubAgentError {
  constructor(toolName: string) {
    super(`tool "${toolName}" not in allowedToolNames`, 'TOOL_NOT_ALLOWED')
  }
}

export class ToolNotFoundError extends SubAgentError {
  constructor(toolName: string) {
    super(`tool "${toolName}" not found in catalog`, 'TOOL_NOT_FOUND')
  }
}
