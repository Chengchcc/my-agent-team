import type { WorkSummary } from "@my-agent-team/plugin-goal";

export interface GoalHistoryEntry {
  turn: number;
  summary: WorkSummary;
  met: boolean;
  reason: string;
  ts: number;
}

export interface GoalState {
  condition: string | null;
  paused: boolean;
  turns: number;
  tokens: number;
  history: GoalHistoryEntry[];
}

export function createGoalState(): GoalState {
  return { condition: null, paused: false, turns: 0, tokens: 0, history: [] };
}

// Per-conversation goal state registry (in-memory, not persisted)
const goalStates = new Map<string, GoalState>();

export function getGoalState(conversationId: string): GoalState {
  let state = goalStates.get(conversationId);
  if (!state) {
    state = createGoalState();
    goalStates.set(conversationId, state);
  }
  return state;
}

export function clearGoalState(conversationId: string): void {
  goalStates.delete(conversationId);
}
