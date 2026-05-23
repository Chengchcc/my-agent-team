import type { Tool } from './tool';

export interface ToolCatalog {
  register(tool: Tool): void;
  unregister(name: string): void;
  list(): Tool[];
  get(name: string): Tool | undefined;
}
