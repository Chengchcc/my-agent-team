// Resolve-tools usecase — pure orchestration signatures.
// No IO, no adapter imports. Merging and filtering only.

interface ToolDescriptor {
  name: string
  description: string
  parameters: Record<string, unknown>
}

// Pure function: merges builtin + skill + MCP tools, applies whitelist.
// Deduplicates by name — later sources (MCP > skill > builtin) win.
function resolveTools(
  builtinTools: ToolDescriptor[],
  skillTools: ToolDescriptor[],
  mcpTools: ToolDescriptor[],
  whitelist?: string[],
): ToolDescriptor[] {
  const merged = new Map<string, ToolDescriptor>()

  for (const tool of builtinTools) {
    merged.set(tool.name, tool)
  }
  for (const tool of skillTools) {
    merged.set(tool.name, tool)
  }
  for (const tool of mcpTools) {
    merged.set(tool.name, tool)
  }

  let tools = Array.from(merged.values())

  if (whitelist !== undefined) {
    const allowed = new Set(whitelist)
    tools = tools.filter(t => allowed.has(t.name))
  }

  return tools
}

// Pure function: filters tools by permission level.
function filterByPermission(
  tools: ToolDescriptor[],
  allowedTools: Set<string>,
): ToolDescriptor[] {
  return tools.filter(t => allowedTools.has(t.name))
}

export type { ToolDescriptor }
export { resolveTools, filterByPermission }
