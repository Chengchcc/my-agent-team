import type { ToolCatalog } from '../ports/tool-catalog';
import type { Tool } from '../ports/tool';

export class InMemoryCatalog implements ToolCatalog {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }
}
