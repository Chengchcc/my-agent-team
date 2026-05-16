// src/tools/sub-registry.ts
import { ToolRegistry } from '../agent/tool-registry';
import type { Tool, ToolImplementation } from '../types';

/**
 * SubToolRegistry — a read-only view over a master ToolRegistry.
 *
 * Delegates all lookups to the master but only exposes tools whose names
 * pass the filter function. Zero copy; reflects master changes automatically
 * (no snapshot, no duplication, no stale state).
 *
 * Mutation methods (register, unregister, clear) throw — this is a view,
 * not an independent registry.
 */
export class SubToolRegistry extends ToolRegistry {
  constructor(
    private master: ToolRegistry,
    private filterFn: (name: string) => boolean,
  ) {
    super();
  }

  override getAllDefinitions(): Tool[] {
    return this.master.getAllDefinitions().filter(d => this.filterFn(d.name));
  }

  override get(name: string): ToolImplementation | undefined {
    return this.filterFn(name) ? this.master.get(name) : undefined;
  }

  override has(name: string): boolean {
    return this.filterFn(name) && this.master.has(name);
  }

  override size(): number {
    let count = 0;
    for (const name of this.master.tools.keys()) {
      if (this.filterFn(name)) count++;
    }
    return count;
  }

  override get tools(): ReadonlyMap<string, ToolImplementation> {
    const filtered = new Map<string, ToolImplementation>();
    for (const [name, impl] of this.master.tools) {
      if (this.filterFn(name)) filtered.set(name, impl);
    }
    return filtered;
  }

  override register(_tool: ToolImplementation): void {
    throw new Error('SubToolRegistry: register() is not allowed on a read-only view');
  }

  override unregister(_name: string): boolean {
    throw new Error('SubToolRegistry: unregister() is not allowed on a read-only view');
  }

  override clear(): void {
    throw new Error('SubToolRegistry: clear() is not allowed on a read-only view');
  }
}
