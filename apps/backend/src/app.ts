import { Elysia } from "elysia";
import type { agentRoutes } from "./features/agent/http.js";
import type { conversationRoutes } from "./features/conversation/http.js";
import type { cronJobRoutes } from "./features/cron/http.js";
import type { loopRoutes } from "./features/loop/http.js";
import type { projectRoutes } from "./features/project/http.js";
import type { opsRoutes } from "./features/runtime-ops/http.js";
import type { settingsRoutes } from "./features/settings/http.js";
import type { skillPackRoutes } from "./features/skill-pack/http.js";
import type { resumeRoutes } from "./features/span/http.js";
import { checkAuthToken } from "./infra/auth.js";
import { HttpError } from "./infra/errors.js";

export interface FeatureSet {
  agents: ReturnType<typeof agentRoutes>;
  conversations: ReturnType<typeof conversationRoutes>;
  ops: ReturnType<typeof opsRoutes>;
  projects: ReturnType<typeof projectRoutes>;
  cronJobs: ReturnType<typeof cronJobRoutes>;
  loops: ReturnType<typeof loopRoutes>;
  resumeRun: ReturnType<typeof resumeRoutes>;
  skillPacks: ReturnType<typeof skillPackRoutes>;
  settings: ReturnType<typeof settingsRoutes>;
}

// ── Auth plugin ──

function authPlugin(token: string) {
  return new Elysia({ name: "auth" }).onBeforeHandle(({ path, headers, set }) => {
    if (path === "/health") return undefined;
    if (!checkAuthToken(headers["x-auth-token"] ?? "", token)) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
    return undefined;
  });
}

// ── Feature route plugins ──

// ── App factory ──

export function createApp(token: string, features: FeatureSet) {
  const { agents, conversations, ops, projects, cronJobs, resumeRun, skillPacks, loops, settings } =
    features;
  const app = new Elysia()
    .get("/health", () => ({ status: "ok" }))
    .use(authPlugin(token))
    .use(agents)
    .use(conversations)
    .use(ops);

  return app
    .use(resumeRun)
    .use(projects)
    .use(cronJobs)
    .use(loops)
    .use(skillPacks)
    .use(settings)
    .onError(({ code, error, set }) => {
      if (error instanceof HttpError) {
        set.status = (error as HttpError).status;
        return { error: error.message };
      }
      if (code === "NOT_FOUND") return { error: "Not found" };
      set.status = 500;
      return { error: "Internal server error" };
    });
}

export type App = ReturnType<typeof createApp>;
