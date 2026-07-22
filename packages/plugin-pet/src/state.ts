import type { PetState } from "./types.js";

/** Award XP for a completed turn. Returns true if leveled up. */
export function awardXP(state: PetState): boolean {
  state.xp += 10;
  if (state.consecutiveErrors === 0) state.xp += 5;
  const xpForNextLevel = state.level * 100;
  if (state.xp >= xpForNextLevel) {
    state.xp -= xpForNextLevel;
    state.level++;
    state.mood = "excited";
    return true;
  }
  return false;
}

/** Decay non-frustrated elevated moods back to neutral. */
export function updateMood(state: PetState): void {
  if (state.mood === "frustrated") return;
  if (state.mood === "happy" || state.mood === "excited") {
    state.mood = "neutral";
  }
}
