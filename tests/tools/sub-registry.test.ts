import { describe, it, expect } from 'bun:test';
import { ToolRegistry } from '../../src/agent/tool-registry';
import { SubToolRegistry } from '../../src/tools/sub-registry';
import type { Tool, ToolImplementation } from '../../src/types';

/** Minimal mock tool implementation for testing. */
function makeTool(name: string): ToolImplementation {
  return {
    getDefinition(): Tool {
      return {
        name,
        description: `${name} description`,
        parameters: {},
      };
    },
    async execute(_params: Record<string, unknown>): Promise<unknown> {
      return `executed ${name}`;
    },
  };
}

function makeReadonlyTool(name: string): ToolImplementation {
  const t = makeTool(name);
  (t as Record<string, unknown>).readonly = true;
  return t;
}

describe('SubToolRegistry', () => {
  it('get() returns tool when filter allows', () => {
    const master = new ToolRegistry();
    master.register(makeTool('bash'));
    master.register(makeTool('read'));

    const sub = new SubToolRegistry(master, () => true);
    expect(sub.get('bash')).toBeDefined();
    expect(sub.get('read')).toBeDefined();
  });

  it('get() returns undefined when filter rejects', () => {
    const master = new ToolRegistry();
    master.register(makeTool('bash'));
    master.register(makeTool('read'));

    // Allow only 'read'
    const sub = new SubToolRegistry(master, (name) => name === 'read');
    expect(sub.get('bash')).toBeUndefined();
    expect(sub.get('read')).toBeDefined();
  });

  it('getAllDefinitions() returns filtered list', () => {
    const master = new ToolRegistry();
    master.register(makeTool('bash'));
    master.register(makeTool('read'));
    master.register(makeTool('grep'));

    // Allow 'read' and 'grep', but not 'bash'
    const sub = new SubToolRegistry(master, (name) => name !== 'bash');
    const defs = sub.getAllDefinitions();
    expect(defs).toHaveLength(2);
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(['grep', 'read']);
  });

  it('follows master changes — register new tool makes it visible in sub', () => {
    const master = new ToolRegistry();
    master.register(makeTool('bash'));

    const sub = new SubToolRegistry(master, () => true);
    expect(sub.size()).toBe(1);

    // Register a new tool on the master
    master.register(makeTool('read'));
    expect(sub.size()).toBe(2);
    expect(sub.get('read')).toBeDefined();
  });

  it('follows master changes — unregister removes from sub', () => {
    const master = new ToolRegistry();
    master.register(makeTool('bash'));
    master.register(makeTool('read'));

    const sub = new SubToolRegistry(master, () => true);
    expect(sub.size()).toBe(2);

    master.unregister('bash');
    expect(sub.size()).toBe(1);
    expect(sub.get('bash')).toBeUndefined();
    expect(sub.get('read')).toBeDefined();
  });

  it('has() respects filter', () => {
    const master = new ToolRegistry();
    master.register(makeTool('bash'));
    master.register(makeTool('read'));

    const sub = new SubToolRegistry(master, (name) => name === 'read');
    expect(sub.has('bash')).toBe(false);
    expect(sub.has('read')).toBe(true);
  });

  it('size() counts only filtered tools', () => {
    const master = new ToolRegistry();
    master.register(makeTool('a'));
    master.register(makeTool('b'));
    master.register(makeTool('c'));

    // Allow only tools whose names start with 'a' or 'b'
    const sub = new SubToolRegistry(master, (name) => name === 'a' || name === 'b');
    expect(sub.size()).toBe(2);
  });

  it('register() throws — read-only view', () => {
    const master = new ToolRegistry();
    const sub = new SubToolRegistry(master, () => true);
    expect(() => sub.register(makeTool('newtool'))).toThrow('register() is not allowed on a read-only view');
  });

  it('unregister() throws — read-only view', () => {
    const master = new ToolRegistry();
    const sub = new SubToolRegistry(master, () => true);
    expect(() => sub.unregister('any')).toThrow('unregister() is not allowed on a read-only view');
  });

  it('clear() throws — read-only view', () => {
    const master = new ToolRegistry();
    const sub = new SubToolRegistry(master, () => true);
    expect(() => sub.clear()).toThrow('clear() is not allowed on a read-only view');
  });

  it('tools getter returns filtered map', () => {
    const master = new ToolRegistry();
    master.register(makeTool('bash'));
    master.register(makeTool('read'));
    master.register(makeTool('grep'));

    const sub = new SubToolRegistry(master, (name) => name.startsWith('b') || name.startsWith('g'));
    const tools = sub.tools;
    expect(tools.size).toBe(2);
    expect(tools.has('bash')).toBe(true);
    expect(tools.has('grep')).toBe(true);
    expect(tools.has('read')).toBe(false);
  });

  it('getAllDefinitions() cache does not break sub-view after master mutation', () => {
    const master = new ToolRegistry();
    master.register(makeTool('bash'));

    const sub = new SubToolRegistry(master, () => true);
    expect(sub.getAllDefinitions()).toHaveLength(1);

    master.register(makeTool('read'));
    expect(sub.getAllDefinitions()).toHaveLength(2);
  });
});
