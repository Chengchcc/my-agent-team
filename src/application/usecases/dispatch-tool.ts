import type { ToolCatalog } from '../ports/tool-catalog';
import type { ToolExecutor } from '../ports/tool-executor';
import type { ToolContext } from '../ports/tool-context';

export async function dispatchTool(
  catalog: ToolCatalog,
  executor: ToolExecutor,
  call: { name: string; arguments: Record<string, unknown> },
  ctx: ToolContext,
): Promise<unknown> {
  const tool = catalog.get(call.name);
  if (!tool) {
    return { content: `Tool not found: ${call.name}`, isError: true };
  }

  const input = tool.parse ? tool.parse(call.arguments) : call.arguments;
  return executor.execute(tool, input, ctx);
}
