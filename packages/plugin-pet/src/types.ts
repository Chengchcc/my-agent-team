export type PetMood = "happy" | "neutral" | "frustrated" | "excited";

export interface PetBark {
  mood: PetMood;
  text: string;
  level: number;
  turn: number;
}

/** 持久化状态（跨 session） */
export interface PetPersistedState {
  level: number;
  xp: number;
  totalTurns: number;
  totalBarks: number;
}

/** 完整状态（持久化 + 会话内） */
export interface PetState extends PetPersistedState {
  mood: PetMood;
  consecutiveErrors: number;
  lastBarkTurn: number;
  turnCount: number;
  lastReviewedMessageCount: number;
  barkHistory: Set<string>;
}

export function createInitialState(): PetState {
  return {
    level: 1,
    xp: 0,
    totalTurns: 0,
    totalBarks: 0,
    mood: "neutral",
    consecutiveErrors: 0,
    lastBarkTurn: 0,
    turnCount: 0,
    lastReviewedMessageCount: 0,
    barkHistory: new Set(),
  };
}

export function toPersisted(state: PetState): PetPersistedState {
  return {
    level: state.level,
    xp: state.xp,
    totalTurns: state.totalTurns,
    totalBarks: state.totalBarks,
  };
}

export function fromPersisted(persisted: PetPersistedState): PetState {
  return {
    ...createInitialState(),
    ...persisted,
  };
}
