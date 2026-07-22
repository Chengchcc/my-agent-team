export { filterBark, generateBark, shouldBark } from "./bark.js";
export { PetBarkKey, type PetPluginOptions, petPlugin } from "./pet-plugin.js";
export { awardXP, updateMood } from "./state.js";
export type { PetBark, PetMood, PetPersistedState, PetState } from "./types.js";
export { createInitialState, fromPersisted, toPersisted } from "./types.js";
