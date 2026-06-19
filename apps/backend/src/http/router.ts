import type { agentRoutes } from "../features/agent/http.js";
import type { columnConfigRoutes } from "../features/column-config/http.js";
import type { conversationRoutes } from "../features/conversation/http.js";
import type { issueRoutes } from "../features/issue/http.js";
import type { projectRoutes } from "../features/project/http.js";
import type { runRoutes } from "../features/run/http.js";
import type { opsRoutes } from "../features/runtime-ops/http.js";
import type { threadProjectionRoutes } from "../features/thread-projection/http.js";
import { HttpError } from "../infra/errors.js";
import { withAuth } from "./middleware.js";
import { json } from "./response.js";

interface FeatureSet {
  agents: ReturnType<typeof agentRoutes>;
  runs: ReturnType<typeof runRoutes>;
  threadProjections: ReturnType<typeof threadProjectionRoutes>;
  conversations?: ReturnType<typeof conversationRoutes>;
  ops?: ReturnType<typeof opsRoutes>;
  issues?: ReturnType<typeof issueRoutes>;
  projects?: ReturnType<typeof projectRoutes>;
  columnConfigs?: ReturnType<typeof columnConfigRoutes>;
}

export function createRouter(token: string, features?: FeatureSet) {
  const health = (_req: Request): Promise<Response> => Promise.resolve(json({ status: "ok" }));

  const notFound = (_req: Request): Promise<Response> =>
    Promise.resolve(json({ error: "Not found" }, 404));

  if (!features) {
    // Lightweight mode for tests — only health + auth check
    const agentsList = withAuth(async (_req: Request) => json([]), token);
    return async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      if (url.pathname === "/health") return health(req);
      if (url.pathname === "/api/agents") {
        if (req.method === "GET") return agentsList(req);
      }
      return withAuth(async () => notFound(req), token)(req);
    };
  }

  const { agents, runs, conversations, ops, issues, projects, columnConfigs } = features;

  const agentList = withAuth((req) => agents.list(req), token);
  const agentCreate = withAuth((req) => agents.create(req), token);

  return async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // Health
      if (path === "/health") return health(req);

      // Agents
      const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/);
      const agentIdentityMatch = path.match(/^\/api\/agents\/([^/]+)\/identity$/);
      if (path === "/api/agents" && method === "GET") return agentList(req);
      if (path === "/api/agents" && method === "POST") return agentCreate(req);
      // M6: 405 for known paths with wrong method
      if (path === "/api/agents") return json({ error: "Method not allowed" }, 405);
      if (agentMatch && method === "GET")
        return withAuth((r) => agents.getById(r, agentMatch?.[1] ?? ""), token)(req);
      if (agentMatch && method === "PATCH")
        return withAuth((r) => agents.update(r, agentMatch?.[1] ?? ""), token)(req);
      if (agentMatch && method === "DELETE")
        return withAuth((r) => agents.archive(r, agentMatch?.[1] ?? ""), token)(req);
      if (agentMatch) return json({ error: "Method not allowed" }, 405);
      // D11: agent identity (SOUL/USER/memory)
      if (agentIdentityMatch && method === "GET")
        return withAuth((r) => agents.identity(r, agentIdentityMatch[1]!), token)(req);
      if (agentIdentityMatch && method === "PUT")
        return withAuth((r) => agents.updateIdentity(r, agentIdentityMatch[1]!), token)(req);
      if (agentIdentityMatch) return json({ error: "Method not allowed" }, 405);
      // M15.1: Lark setup routes
      const agentLarkSetupMatch = path.match(/^\/api\/agents\/([^/]+)\/lark\/setup$/);
      const agentLarkSetupIdMatch = path.match(/^\/api\/agents\/([^/]+)\/lark\/setup\/([^/]+)$/);
      if (agentLarkSetupMatch && method === "POST")
        return withAuth((r) => agents.larkSetup(r, agentLarkSetupMatch[1]!), token)(req);
      if (agentLarkSetupIdMatch && method === "GET")
        return withAuth(
          (r) => agents.larkSetupStatus(r, agentLarkSetupIdMatch[1]!, agentLarkSetupIdMatch[2]!),
          token,
        )(req);
      if (agentLarkSetupIdMatch && method === "DELETE")
        return withAuth(
          (r) => agents.larkSetupCancel(r, agentLarkSetupIdMatch[1]!, agentLarkSetupIdMatch[2]!),
          token,
        )(req);
      if (agentLarkSetupMatch) return json({ error: "Method not allowed" }, 405);

      // Runs — cancel, resume, get
      const cancelMatch = path.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      const resumeMatch = path.match(/^\/api\/runs\/([^/]+)\/resume$/);
      const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);

      if (cancelMatch && method === "POST")
        return withAuth((r) => runs.cancel(r, cancelMatch[1]!), token)(req);
      if (cancelMatch) return json({ error: "Method not allowed" }, 405);
      if (resumeMatch && method === "POST")
        return withAuth((r) => runs.resume(r, resumeMatch[1]!), token)(req);
      if (resumeMatch) return json({ error: "Method not allowed" }, 405);
      if (runMatch && method === "GET")
        return withAuth((r) => runs.getById(r, runMatch[1]!), token)(req);
      if (runMatch) return json({ error: "Method not allowed" }, 405);

      // Conversations — M10
      if (conversations) {
        const convListMatch = path === "/api/conversations";
        const convSnapMatch = path.match(/^\/api\/conversations\/([^/]+)$/);
        const convMsgMatch = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
        const convMemberMatch = path.match(/^\/api\/conversations\/([^/]+)\/members$/);
        const convEventsMatch = path.match(/^\/api\/conversations\/([^/]+)\/events$/);
        const convStartNewMatch = path.match(/^\/api\/conversations\/([^/]+)\/start-new$/);

        if (convListMatch && method === "GET")
          return withAuth(async (r) => conversations.list(r), token)(req);
        if (convListMatch && method === "POST")
          return withAuth((r) => conversations.create(r), token)(req);
        if (convListMatch) return json({ error: "Method not allowed" }, 405);
        if (convSnapMatch && method === "GET")
          return withAuth((r) => conversations.snapshot(r, convSnapMatch[1]!), token)(req);
        if (convSnapMatch && method === "DELETE")
          return withAuth(async (r) => conversations.delete(r, convSnapMatch[1]!), token)(req);
        if (convSnapMatch) return json({ error: "Method not allowed" }, 405);
        if (convMsgMatch && method === "POST")
          return withAuth((r) => conversations.postMessage(r, convMsgMatch[1]!), token)(req);
        if (convMsgMatch) return json({ error: "Method not allowed" }, 405);
        if (convMemberMatch && method === "POST")
          return withAuth((r) => conversations.addMember(r, convMemberMatch[1]!), token)(req);
        if (convMemberMatch && method === "DELETE")
          return withAuth((r) => conversations.removeMember(r, convMemberMatch[1]!), token)(req);
        if (convMemberMatch) return json({ error: "Method not allowed" }, 405);
        if (convEventsMatch && method === "GET")
          return withAuth((r) => conversations.events(r, convEventsMatch[1]!), token)(req);
        if (convEventsMatch) return json({ error: "Method not allowed" }, 405);
        if (convStartNewMatch && method === "POST")
          return withAuth((r) => conversations.startNew(r, convStartNewMatch[1]!), token)(req);
        if (convStartNewMatch) return json({ error: "Method not allowed" }, 405);
      }

      // M16: Ops routes
      if (ops) {
        const opsRunsMatch = path === "/api/ops/runs";
        const opsRunDetailMatch = path.match(/^\/api\/ops\/runs\/([^/]+)$/);
        const opsRunCancelMatch = path.match(/^\/api\/ops\/runs\/([^/]+)\/cancel$/);
        const opsRunRecoverMatch = path.match(/^\/api\/ops\/runs\/([^/]+)\/recover$/);
        const opsRunInsightsMatch = path.match(/^\/api\/ops\/runs\/([^/]+)\/insights$/);
        const opsInsightsSummaryMatch = path === "/api/ops/insights/summary";
        const opsAgentRuntimeMatch = path.match(/^\/api\/ops\/agents\/([^/]+)\/runtime$/);
        const larkHeartbeatMatch = path === "/api/internal/surfaces/lark/heartbeat";
        const opsTracesMatch = path.match(/^\/api\/ops\/traces\/([^/]+)$/);
        const opsSurfacesMatch = path === "/api/ops/surfaces";

        if (opsRunsMatch && method === "GET") return withAuth((r) => ops.listRuns(r), token)(req);
        if (opsRunDetailMatch && method === "GET")
          return withAuth((r) => ops.getRunDetail(r, opsRunDetailMatch[1]!), token)(req);
        if (opsRunCancelMatch && method === "POST")
          return withAuth((r) => ops.cancelRun(r, opsRunCancelMatch[1]!), token)(req);
        if (opsRunRecoverMatch && method === "POST")
          return withAuth((r) => ops.recoverRun(r, opsRunRecoverMatch[1]!), token)(req);
        if (opsRunInsightsMatch && method === "GET")
          return withAuth((r) => ops.getRunInsights(r, opsRunInsightsMatch[1]!), token)(req);
        if (opsInsightsSummaryMatch && method === "GET")
          return withAuth((r) => ops.getInsightsSummary(r), token)(req);
        if (opsAgentRuntimeMatch && method === "GET")
          return withAuth((r) => ops.getAgentRuntime(r, opsAgentRuntimeMatch[1]!), token)(req);
        if (opsTracesMatch && method === "GET")
          return withAuth((r) => ops.getTraceDetail(r, opsTracesMatch[1]!), token)(req);
        if (opsSurfacesMatch && method === "GET")
          return withAuth((r) => ops.listSurfaces(r), token)(req);
        if (larkHeartbeatMatch && method === "POST")
          return withAuth((r) => ops.larkHeartbeat(r), token)(req);
      }

      // M18.1: Issue routes
      if (issues) {
        const issuesListMatch = path === "/api/issues";
        const issueEventsMatch = path === "/api/issues/events";
        const issueTransitionMatch = path.match(/^\/api\/issues\/([^/]+)\/transition$/);
        const issueDeliverablesMatch = path.match(/^\/api\/issues\/([^/]+)\/deliverables$/);
        const issueDetailMatch = path.match(/^\/api\/issues\/([^/]+)$/);
        const issueMetaMatch = path === "/api/issue-meta";

        // SSE events must be matched before /:id regex
        if (issueEventsMatch && method === "GET")
          return withAuth(async (r) => issues.events(r), token)(req);
        if (issueMetaMatch && method === "GET")
          return withAuth(async () => issues.meta(), token)(req);
        if (issuesListMatch && method === "GET")
          return withAuth(async (r) => issues.list(r), token)(req);
        if (issuesListMatch && method === "POST")
          return withAuth(async (r) => issues.create(r), token)(req);
        // transition must be before detail to avoid /:id capturing /:id/transition
        if (issueTransitionMatch && method === "POST")
          return withAuth(async (r) => issues.transition(r, issueTransitionMatch[1]!), token)(req);
        // deliverables must be before detail to avoid /:id capturing /:id/deliverables
        if (issueDeliverablesMatch && method === "POST")
          return withAuth(
            async (r) => issues.submitDeliverable(r, issueDeliverablesMatch[1]!),
            token,
          )(req);
        if (issueDetailMatch && method === "GET")
          return withAuth(async (r) => issues.get(r, issueDetailMatch[1]!), token)(req);

        // 405 for known paths with wrong method
        if (issuesListMatch) return json({ error: "Method not allowed" }, 405);
        if (issueEventsMatch) return json({ error: "Method not allowed" }, 405);
        if (issueMetaMatch) return json({ error: "Method not allowed" }, 405);
        if (issueTransitionMatch) return json({ error: "Method not allowed" }, 405);
        if (issueDeliverablesMatch) return json({ error: "Method not allowed" }, 405);
        if (issueDetailMatch) return json({ error: "Method not allowed" }, 405);
      }

      // M18.3: Project routes
      if (projects) {
        const projectsListMatch = path === "/api/projects";
        const projectDetailMatch = path.match(/^\/api\/projects\/([^/]+)$/);
        if (projectsListMatch && method === "GET")
          return withAuth(async (r) => projects.list(r), token)(req);
        if (projectsListMatch && method === "POST")
          return withAuth(async (r) => projects.create(r), token)(req);
        if (projectDetailMatch && method === "GET")
          return withAuth(async (r) => projects.get(r, projectDetailMatch[1]!), token)(req);
        if (projectDetailMatch && method === "PATCH")
          return withAuth(async (r) => projects.update(r, projectDetailMatch[1]!), token)(req);
        if (projectDetailMatch && method === "DELETE")
          return withAuth(async (r) => projects.remove(r, projectDetailMatch[1]!), token)(req);
        if (projectsListMatch) return json({ error: "Method not allowed" }, 405);
        if (projectDetailMatch) return json({ error: "Method not allowed" }, 405);
      }

      // M18.4: ColumnConfig routes
      if (columnConfigs) {
        const ccListMatch = path === "/api/column-configs";
        const ccDetailMatch = path.match(/^\/api\/column-configs\/([^/]+)$/);
        if (ccListMatch && method === "GET")
          return withAuth(async (r) => columnConfigs.list(r), token)(req);
        if (ccListMatch && method === "POST")
          return withAuth(async (r) => columnConfigs.upsert(r), token)(req);
        if (ccDetailMatch && method === "DELETE")
          return withAuth(async (r) => columnConfigs.remove(r, ccDetailMatch[1]!), token)(req);
        if (ccListMatch) return json({ error: "Method not allowed" }, 405);
        if (ccDetailMatch) return json({ error: "Method not allowed" }, 405);
      }

      return withAuth(async () => notFound(req), token)(req);
    } catch (err) {
      // M6: top-level error boundary — use HttpError status, never leak internal messages
      if (err instanceof HttpError) {
        return json({ error: err.message }, err.status);
      }
      return json({ error: "Internal server error" }, 500);
    }
  };
}
