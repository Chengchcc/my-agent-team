import { Elysia } from "elysia";
import type { agentRoutes } from "./features/agent/http.js";
import type { columnConfigRoutes } from "./features/column-config/http.js";
import type { conversationRoutes } from "./features/conversation/http.js";
import type { cronJobRoutes } from "./features/cron/http.js";
import type { issueRoutes } from "./features/issue/http.js";
import type { projectRoutes } from "./features/project/http.js";
import type { opsRoutes } from "./features/runtime-ops/http.js";
import { checkAuthToken } from "./infra/auth.js";
import { HttpError } from "./infra/errors.js";

// ── Feature set (same shape as router.ts FeatureSet) ──

export interface FeatureSet {
  agents: ReturnType<typeof agentRoutes>;
  conversations?: ReturnType<typeof conversationRoutes>;
  ops?: ReturnType<typeof opsRoutes>;
  issues?: ReturnType<typeof issueRoutes>;
  projects?: ReturnType<typeof projectRoutes>;
  columnConfigs?: ReturnType<typeof columnConfigRoutes>;
  cronJobs?: ReturnType<typeof cronJobRoutes>;
  resumeRun?: (req: Request, spanId: string) => Promise<Response>;
}

// ── App factory ──

export function createApp(token: string, features?: FeatureSet) {
  const app = new Elysia()
    // Health — no auth
    .get("/health", () => ({ status: "ok" }));

  if (!features) {
    // Lightweight test mode
    return app.get("/api/agents", () => []);
  }

  const { agents, conversations, ops, issues, projects, columnConfigs, cronJobs } = features;

  // Auth: global onBeforeHandle after /health. Matches legacy withAuth semantics.
  app.onBeforeHandle(({ path, headers, set }) => {
    if (path === "/health") return undefined;
    if (!checkAuthToken(headers["x-auth-token"] ?? "", token)) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
    return undefined;
  });

  // ── Agents ──
  app
    .get("/api/agents", ({ request }) => agents.list(request))
    .post("/api/agents", ({ request }) => agents.create(request))
    .get("/api/agents/:id", ({ request, params: { id } }) => agents.getById(request, id))
    .patch("/api/agents/:id", ({ request, params: { id } }) => agents.update(request, id))
    .delete("/api/agents/:id", ({ request, params: { id } }) => agents.archive(request, id))
    .get("/api/agents/:id/identity", ({ request, params: { id } }) => agents.identity(request, id))
    .put("/api/agents/:id/identity", ({ request, params: { id } }) =>
      agents.updateIdentity(request, id),
    )
    .post("/api/agents/:id/lark/setup", ({ request, params: { id } }) =>
      agents.larkSetup(request, id),
    )
    .get("/api/agents/:id/lark/setup/:setupId", ({ request, params: { id, setupId } }) =>
      agents.larkSetupStatus(request, id, setupId),
    )
    .delete("/api/agents/:id/lark/setup/:setupId", ({ request, params: { id, setupId } }) =>
      agents.larkSetupCancel(request, id, setupId),
    );

  // ── Runs (resume only) ──
  if (features.resumeRun) {
    app.post("/api/runs/:id/resume", ({ request, params: { id } }) =>
      features.resumeRun!(request, id),
    );
  }

  // ── Conversations ──
  if (conversations) {
    app
      .get("/api/conversations", ({ request }) => conversations.list(request))
      .post("/api/conversations", ({ request }) => conversations.create(request))
      .get("/api/conversations/:id", ({ request, params: { id } }) =>
        conversations.snapshot(request, id),
      )
      .delete("/api/conversations/:id", ({ request, params: { id } }) =>
        conversations.delete(request, id),
      )
      .post("/api/conversations/:id/messages", ({ request, params: { id } }) =>
        conversations.postMessage(request, id),
      )
      .post("/api/conversations/:id/members", ({ request, params: { id } }) =>
        conversations.addMember(request, id),
      )
      .delete("/api/conversations/:id/members", ({ request, params: { id } }) =>
        conversations.removeMember(request, id),
      )
      .get("/api/conversations/:id/events", ({ request, params: { id } }) =>
        conversations.events(request, id),
      )
      .post("/api/conversations/:id/start-new", ({ request, params: { id } }) =>
        conversations.startNew(request, id),
      );
  }

  // ── Ops ──
  if (ops) {
    app
      .get("/api/ops/sessions", ({ request }) => ops.listSessions(request))
      .get("/api/ops/sessions/:id", ({ request, params: { id } }) =>
        ops.getSessionDetail(request, id),
      )
      .get("/api/ops/runs", ({ request }) => ops.listRuns(request))
      .get("/api/ops/runs/:id", ({ request, params: { id } }) => ops.getRunDetail(request, id))
      .post("/api/ops/runs/:id/cancel", ({ request, params: { id } }) => ops.cancelRun(request, id))
      .post("/api/ops/runs/:id/recover", ({ request, params: { id } }) =>
        ops.recoverRun(request, id),
      )
      .get("/api/ops/runs/:id/insights", ({ request, params: { id } }) =>
        ops.getRunInsights(request, id),
      )
      .get("/api/ops/insights/summary", ({ request }) => ops.getInsightsSummary(request))
      .get("/api/ops/agents/:id/runtime", ({ request, params: { id } }) =>
        ops.getAgentRuntime(request, id),
      )
      .get("/api/ops/traces/:id", ({ request, params: { id } }) => ops.getTraceDetail(request, id))
      .get("/api/ops/surfaces", ({ request }) => ops.listSurfaces(request))
      .post("/api/internal/surfaces/lark/heartbeat", ({ request }) => ops.larkHeartbeat(request));
  }

  // ── Issues ──
  if (issues) {
    app
      .get("/api/issue-meta", () => issues.meta())
      .get("/api/issues/events", ({ request }) => issues.events(request))
      .get("/api/issues", ({ request }) => issues.list(request))
      .post("/api/issues", ({ request }) => issues.create(request))
      .get("/api/issues/:id", ({ request, params: { id } }) => issues.get(request, id))
      .post("/api/issues/:id/transition", ({ request, params: { id } }) =>
        issues.transition(request, id),
      )
      .post("/api/issues/:id/deliverables", ({ request, params: { id } }) =>
        issues.submitDeliverable(request, id),
      )
      .post("/api/issues/:id/review-decision", ({ request, params: { id } }) =>
        issues.reviewDecision(request, id),
      )
      .get("/api/issues/:id/timeline/events", ({ request, params: { id } }) =>
        issues.timelineEvents(request, id),
      )
      .get("/api/issues/:id/timeline", ({ request, params: { id } }) =>
        issues.timeline(request, id),
      )
      .get("/api/issues/:id/detail", ({ request, params: { id } }) => issues.detail(request, id));
  }

  // ── Projects ──
  if (projects) {
    app
      .get("/api/projects", ({ request }) => projects.list(request))
      .post("/api/projects", ({ request }) => projects.create(request))
      .get("/api/projects/:id", ({ request, params: { id } }) => projects.get(request, id))
      .patch("/api/projects/:id", ({ request, params: { id } }) => projects.update(request, id))
      .delete("/api/projects/:id", ({ request, params: { id } }) => projects.remove(request, id));
  }

  // ── Column Configs ──
  if (columnConfigs) {
    app
      .get("/api/column-configs", ({ request }) => columnConfigs.list(request))
      .post("/api/column-configs", ({ request }) => columnConfigs.upsert(request))
      .delete("/api/column-configs/:id", ({ request, params: { id } }) =>
        columnConfigs.remove(request, id),
      );
  }

  // ── Cron Jobs ──
  if (cronJobs) {
    app
      .post("/api/cron-jobs/:id/enable", ({ request, params: { id } }) =>
        cronJobs.setEnabled(request, id),
      )
      .get("/api/cron-jobs", ({ request }) => cronJobs.list(request))
      .post("/api/cron-jobs", ({ request }) => cronJobs.create(request))
      .get("/api/cron-jobs/:id", ({ request, params: { id } }) => cronJobs.get(request, id))
      .patch("/api/cron-jobs/:id", ({ request, params: { id } }) => cronJobs.update(request, id))
      .delete("/api/cron-jobs/:id", ({ request, params: { id } }) => cronJobs.remove(request, id));
  }

  // ── Error boundary ──
  app.onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return { error: error.message };
    }
    if (code === "NOT_FOUND") return { error: "Not found" };
    set.status = 500;
    return { error: "Internal server error" };
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
