import type { EventEnvelope } from './event-envelope';

/** All DataPlane event types — the complete set, including forward-looking types. */
export type DataPlaneEventType =
  | 'snapshot'
  | 'assistant.delta'
  | 'tool.update'
  | 'permission.required'
  | 'permission.resolved'
  | 'ask-user-question.required'
  | 'ask-user-question.resolved'
  | 'user.question'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.failed'
  | 'session.compacted'
  | 'state.changed'
  | 'attach.changed'
  | 'identity.changed'
  | 'skills.reloaded'
  | 'mcp.reloaded'
  | 'evolution.progress'
  | 'evolution.skillProposed'
  | 'system.warn'
  | 'tui.inline-block'
  | 'sub-agent.started'
  | 'sub-agent.completed'
  | 'compaction.started'
  | 'compaction.completed'
  | 'compaction.failed';

/**
 * DataPlaneEvent — the unified event type consumed by frontends via the
 * dataplane facade. Extends EventEnvelope and adds streaming-specific fields.
 */
export interface DataPlaneEvent extends EventEnvelope<DataPlaneEventType> {
  /** Monotonic event id, assigned by dataplane bridge */
  evId: string;
  /** Monotonic cursor for replay/gap-detection */
  cursor: number;
  /** Frontend target id for targeted events */
  target?: string;
}
