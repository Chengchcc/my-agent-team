import { describe, it, expect } from 'bun:test';
import { planExecution } from '../../src/agent/dispatch';
import type { ToolCall, ToolImplementation } from '../../src/types';

function toolDef(name: string, opts: { conflictKey?: (args: unknown) => string | null; readonly?: boolean } = {}): ToolImplementation {
  return {
    getDefinition: () => ({ name, description: name, parameters: { type: 'object', properties: {}, required: [] } }),
    execute: async () => '',
    ...(opts.conflictKey ? { conflictKey: opts.conflictKey } : {}),
    ...(opts.readonly !== undefined ? { readonly: opts.readonly } : {}),
  };
}

function makeCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: name + '_1', name, arguments: args };
}

describe('Tool conflict detection via side effects', () => {
  it('should split read and write to same file into separate waves', () => {
    const calls: ToolCall[] = [
      makeCall('read', { file_path: '/tmp/foo.ts' }),
      makeCall('text_editor', { file: '/tmp/foo.ts' }),
    ];

    const registry = new Map<string, ToolImplementation>();
    // Both tools return conflict=null from conflictKey (no basic conflict),
    // but side-effect detection should split them: read+write on same path
    registry.set('read', toolDef('read', { readonly: true, conflictKey: () => null }));
    registry.set('text_editor', toolDef('text_editor', { readonly: false, conflictKey: () => null }));

    const plan = planExecution(calls, (name) => registry.get(name));
    expect(plan.waves.length).toBe(2);
  });

  it('should keep read+read on different files in same wave', () => {
    const calls: ToolCall[] = [
      makeCall('read', { file_path: '/tmp/a.ts' }),
      makeCall('read', { file_path: '/tmp/b.ts' }),
    ];

    const registry = new Map<string, ToolImplementation>();
    registry.set('read', toolDef('read', { readonly: true, conflictKey: () => null }));

    const plan = planExecution(calls, (name) => registry.get(name));
    expect(plan.waves.length).toBe(1);
    expect(plan.waves[0]!.length).toBe(2);
  });

  it('should isolate bash (execute) from all other tools', () => {
    const calls: ToolCall[] = [
      makeCall('read', { file_path: '/tmp/a.ts' }),
      makeCall('bash', { command: 'ls' }),
    ];

    const registry = new Map<string, ToolImplementation>();
    registry.set('read', toolDef('read', { readonly: true, conflictKey: () => null }));
    registry.set('bash', toolDef('bash', { readonly: false, conflictKey: () => null }));

    const plan = planExecution(calls, (name) => registry.get(name));
    expect(plan.waves.length).toBe(2);
  });
});
