/** Edge-safe public entrypoint (pure Zod env schema).
 *  Node/Bun filesystem primitives (`agent-status`, `gateway-secrets`,
 *  `skill-index`) live under `@chengchenccc/config/node` so Next.js Edge
 *  middleware (`apps/web/src/middleware.ts`) never pulls `node:fs` into the
 *  webpack bundle. */
export type { Env } from "./env.js";
export { envSchema, parseEnv } from "./env.js";
