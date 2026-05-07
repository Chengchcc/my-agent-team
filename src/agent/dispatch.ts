import type { ToolCall, ToolImplementation } from '../types';
import type { ToolSideEffect } from './tool-dispatch/types';

export interface ExecutionPlan {
  /** Waves are executed sequentially; tools within a wave run in parallel. */
  waves: ToolCall[][];
}

/**
 * Group tool calls into execution waves based on readonly/conflictKey metadata.
 *
 * Strategy (first applicable wins):
 * 1. If conflictKey returns null → tool has no conflicts, can batch with others.
 * 2. If conflictKey returns a string → tool must run in its own wave.
 * 3. If no conflictKey defined: readonly tools batch, non-readonly get own wave.
 *
 * This enables sub_agent(read_only) to run in parallel with read_file/grep/glob.
 */
export function planExecution(
  calls: ToolCall[],
  lookup: (name: string) => ToolImplementation | undefined,
): ExecutionPlan {
  const waves: ToolCall[][] = [];
  let currentWave: ToolCall[] = [];

  const flush = () => {
    if (currentWave.length) {
      waves.push(currentWave);
      currentWave = [];
    }
  };

  for (const call of calls) {
    const tool = lookup(call.name);
    const conflict = resolveConflict(call, tool);

    if (conflict !== null) {
      flush();
      waves.push([call]);
      continue;
    }

    // Check side-effect conflicts against current wave members
    const effects = getSideEffects(call.name, call.arguments as Record<string, unknown>);
    const conflictsWithWave = currentWave.some(existing => {
      const existingEffects = getSideEffects(
        existing.name,
        existing.arguments as Record<string, unknown>,
      );
      return hasSideEffectConflict(effects, existingEffects);
    });

    if (conflictsWithWave) {
      flush();
    }
    currentWave.push(call);
  }
  flush();

  return { waves };
}

/**
 * Resolve conflict for a single tool call.
 * Returns null (no conflict, safe to batch) or a string key (needs own wave).
 */
function resolveConflict(call: ToolCall, tool?: ToolImplementation): string | null {
  // If tool defines conflictKey, it takes precedence
  if (tool?.conflictKey) {
    try {
      return tool.conflictKey(call.arguments);
    } catch {
      return call.name; // Parse error → play it safe
    }
  }
  // Default: readonly tools are conflict-free, others get own wave
  return tool?.readonly ? null : call.name;
}

function eff(type: 'read' | 'write' | 'execute', path?: string): ToolSideEffect {
  const e: ToolSideEffect = { type };
  if (path !== undefined) e.path = path;
  return e;
}

function getSideEffects(name: string, args: Record<string, unknown>): ToolSideEffect[] {
  switch (name) {
    case 'read':
      return [eff('read', args.file_path as string | undefined)];
    case 'grep':
      return [eff('read', args.path as string | undefined)];
    case 'glob':
      return [eff('read', args.path as string | undefined)];
    case 'ls':
      return [eff('read', args.path as string | undefined)];
    case 'text_editor':
      return [eff('write', args.file as string | undefined)];
    case 'bash':
      return [eff('execute')];
    default:
      return [];
  }
}

function hasSideEffectConflict(a: ToolSideEffect[], b: ToolSideEffect[]): boolean {
  for (const sa of a) {
    for (const sb of b) {
      if (sa.type === 'execute' || sb.type === 'execute') return true;
      if (sa.type === 'write' && sb.type === 'write' && sa.path && sb.path && sa.path === sb.path) return true;
      if ((sa.type === 'write' && sb.type === 'read') || (sa.type === 'read' && sb.type === 'write')) {
        if (sa.path && sb.path && sa.path === sb.path) return true;
      }
    }
  }
  return false;
}
