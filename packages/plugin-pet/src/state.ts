import type { PetState } from "./types.js";

/** Award XP for a completed turn. */
export function awardXP(state: PetState): boolean {
  state.xp += 10;
  if (state.consecutiveErrors === 0) state.xp += 5;
  const xpForNextLevel = state.level * 100;
  if (state.xp >= xpForNextLevel) {
    state.xp -= xpForNextLevel;
    state.level++;
    return true; // leveled up
  }
  return false;
}

/** Update mood based on turn-level signals. */
export function updateMood(state: PetState): void {
  // Frustrated already set by afterTool (3+ consecutive errors)
  if (state.mood === "frustrated") return;

  // Non-frustrated moods decay to neutral after 1 turn
  if (state.mood === "happy" || state.mood === "excited") {
    state.mood = "neutral";
    return;
  }

  // Neutral stays neutral (happy/excited set by specific signals)
  // ponytail: no complex signal detection for now -- afterTool handles frustrated
}
