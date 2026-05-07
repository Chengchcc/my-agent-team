import { describe, it, expect } from 'bun:test';
import { defineMetadataKey, getMetadata, setMetadata } from '../../src/types';
import type { AgentContext } from '../../src/types';

interface TodoState {
  active: number;
  completed: number;
}

const TodoKey = defineMetadataKey<TodoState>('todo-state');
const CollapsedKey = defineMetadataKey<boolean>('just-collapsed');

function makeCtx(): AgentContext {
  return {
    messages: [],
    systemPrompt: '',
    config: { tokenLimit: 100000 },
    metadata: {} as Record<string, unknown>,
    provider: { getModelName: () => 'test' } as any,
  };
}

describe('Typed metadata accessors', () => {
  it('should round-trip typed values', () => {
    const ctx = makeCtx();
    setMetadata(ctx, TodoKey, { active: 3, completed: 1 });
    expect(getMetadata(ctx, TodoKey)).toEqual({ active: 3, completed: 1 });
  });

  it('should return undefined for unset keys', () => {
    const ctx = makeCtx();
    expect(getMetadata(ctx, TodoKey)).toBeUndefined();
  });

  it('should isolate different keys', () => {
    const ctx = makeCtx();
    setMetadata(ctx, TodoKey, { active: 1, completed: 0 });
    setMetadata(ctx, CollapsedKey, true);
    expect(getMetadata(ctx, TodoKey)).toEqual({ active: 1, completed: 0 });
    expect(getMetadata(ctx, CollapsedKey)).toBe(true);
  });

  it('should use unique Symbol per key definition', () => {
    const KeyA = defineMetadataKey<string>('a');
    const KeyB = defineMetadataKey<string>('b');
    expect(KeyA.symbol).not.toBe(KeyB.symbol);
  });
});
