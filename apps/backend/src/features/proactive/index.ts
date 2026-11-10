export { sqliteProactiveAdapter } from "./adapter-sqlite.js";
export {
  type AmbientDecision,
  type AmbientSource,
  frameAmbientInput,
  matchAmbientRule,
  type ProactiveEvent,
} from "./domain.js";
export { proactiveRoutes } from "./http.js";
export type { ProactiveEventPort } from "./ports.js";
export { createProactiveService, type ProactiveService } from "./service.js";
