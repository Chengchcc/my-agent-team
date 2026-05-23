const AGENT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/

export interface ValidationError {
  field: string
  message: string
}

export function validateAgent(
  agentId: string,
  displayName: string,
): ValidationError[] {
  const errors: ValidationError[] = []
  if (!agentId || !AGENT_ID_RE.test(agentId)) {
    errors.push({
      field: 'agentId',
      message: 'Must be lowercase slug: ^[a-z][a-z0-9-]{0,31}$',
    })
  }
  if (agentId === 'default') {
    errors.push({
      field: 'agentId',
      message: "'default' is reserved for automatic seeding",
    })
  }
  if (!displayName || displayName.trim().length === 0) {
    errors.push({
      field: 'displayName',
      message: 'Display name is required',
    })
  }
  return errors
}
