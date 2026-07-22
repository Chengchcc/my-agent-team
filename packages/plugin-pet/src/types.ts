export type PetMood = "happy" | "neutral" | "frustrated" | "excited";

export interface PetBark {
  mood: PetMood;
  text: string;
  level: number;
  turn: number;
}

/** Persisted state (cross-session). */
export interface PetPersistedState {
  level: number;
  xp: number;
  totalTurns: number;
  totalBarks: number;
}

/** Full state (persisted + per-run). */
export interface PetState extends PetPersistedState {
  mood: PetMood;
  consecutiveErrors: number;
  consecutiveSuccesses: number;
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
    consecutiveSuccesses: 0,
    lastBarkTurn: 0,
    turnCount: 0,
    lastReviewedMessageCount: 0,
    barkHistory: new Set(),
  };
}
