import type { DataPlaneEvent } from '../../../application/contracts';
import type { AgentEvent } from '../vendor/agent-event';

/* eslint-disable complexity -- exhaustive DataPlaneEvent switch with trivial no-op cases */
export function mapDataPlaneToAgentEvent(evt: DataPlaneEvent): AgentEvent | null {
  const payload = (evt.payload ?? {}) as Record<string, unknown>;
  switch (evt.type) {
    case 'assistant.delta': {
      const delta = typeof payload.delta === 'string' ? payload.delta : '';
      if (!delta) return null;
      return { type: 'text', delta };
    }
    case 'tool.update': {
      const phase = payload.phase as 'start' | 'end' | undefined;
      const id = (payload.callId as string) ?? `${evt.evId}`;
      const name = (payload.name as string) ?? 'unknown';
      if (phase === 'start') return { type: 'tool_use', id, name, input: payload.args ?? {} };
      if (phase === 'end') {
        const isError = payload.err != null;
        const output = typeof payload.result === 'string'
          ? payload.result
          : JSON.stringify(payload.result ?? '');
        return { type: 'tool_result', id, output, isError };
      }
      return null;
    }
    case 'turn.completed':
      return { type: 'done' };
    case 'turn.failed': {
      const reason = typeof payload.reason === 'string' ? payload.reason : 'unknown';
      return { type: 'error', message: reason };
    }
    case 'snapshot': case 'permission.required': case 'permission.resolved':
    case 'ask-user-question.required': case 'ask-user-question.resolved':
    case 'user.question': case 'turn.started': case 'session.compacted':
    case 'state.changed': case 'attach.changed': case 'identity.changed':
    case 'skills.reloaded': case 'mcp.reloaded': case 'evolution.progress':
    case 'system.warn': case 'tui.inline-block':
    case 'compaction.started': case 'compaction.completed': case 'compaction.failed':
      return null;
  }
  return null
}
