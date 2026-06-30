import { Elysia } from "elysia";
import type { agentRoutes } from "./features/agent/http.js";
import type { columnConfigRoutes } from "./features/column-config/http.js";
import type { conversationRoutes } from "./features/conversation/http.js";
import type { cronJobRoutes } from "./features/cron/http.js";
import type { issueRoutes } from "./features/issue/http.js";
import type { projectRoutes } from "./features/project/http.js";
import type { opsRoutes } from "./features/runtime-ops/http.js";
import type { skillPackRoutes } from "./features/skill-pack/http.js";
import type { resumeRoutes } from "./features/span/http.js";
import { checkAuthToken } from "./infra/auth.js";
import { HttpError } from "./infra/errors.js";

export interface FeatureSet {
  agents: ReturnType<typeof agentRoutes>;
  conversations: ReturnType<typeof conversationRoutes>;
  ops: ReturnType<typeof opsRoutes>;
  issues: ReturnType<typeof issueRoutes>;
  projects: ReturnType<typeof projectRoutes>;
  columnConfigs: ReturnType<typeof columnConfigRoutes>;
  cronJobs: ReturnType<typeof cronJobRoutes>;
  resumeRun: ReturnType<typeof resumeRoutes>;
  skillPacks: ReturnType<typeof skillPackRoutes>;
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
  const { agents, conversations, ops, issues, projects, columnConfigs, cronJobs, skillPacks } =
    features;

  const app = new Elysia()
    .get("/health", () => ({ status: "ok" }))
    .use(authPlugin(token))
    .use(agents) // agentRoutes now returns Elysia plugin directly
    .use(conversations)
    .use(ops)
    .use(issues);

  return app
    .use(features.resumeRun)
    .use(projects)
    .use(columnConfigs)
    .use(skillPacks)
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
