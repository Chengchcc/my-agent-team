import type { agentRoutes } from "../features/agent/http.js";
import type { threadProjectionRoutes } from "../features/thread-projection/http.js";
import type { conversationRoutes } from "../features/conversation/http.js";
import type { runRoutes } from "../features/run/http.js";
import { HttpError } from "../infra/errors.js";
import { withAuth } from "./middleware.js";
import { json } from "./response.js";

interface FeatureSet {
  agents: ReturnType<typeof agentRoutes>;
  runs: ReturnType<typeof runRoutes>;
  threadProjections: ReturnType<typeof threadProjectionRoutes>;
  conversations?: ReturnType<typeof conversationRoutes>;
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

  const { agents, runs, conversations } = features;

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
      const agentLarkSetupIdMatch = path.match(
        /^\/api\/agents\/([^/]+)\/lark\/setup\/([^/]+)$/,
      );
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

      // Runs — cancel, events, stream, resume, get
      const cancelMatch = path.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      const eventsMatch = path.match(/^\/api\/runs\/([^/]+)\/events$/);
      const streamMatch = path.match(/^\/api\/runs\/([^/]+)\/stream$/);
      const resumeMatch = path.match(/^\/api\/runs\/([^/]+)\/resume$/);
      const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);

      if (cancelMatch && method === "POST")
        return withAuth((r) => runs.cancel(r, cancelMatch[1]!), token)(req);
      if (cancelMatch) return json({ error: "Method not allowed" }, 405);
      if (eventsMatch && method === "GET")
        return withAuth((r) => runs.events(r, eventsMatch[1]!), token)(req);
      if (eventsMatch) return json({ error: "Method not allowed" }, 405);
      // M13: /stream for ephemeral text_delta SSE
      if (streamMatch && method === "GET")
        return withAuth((r) => runs.stream(r, streamMatch[1]!), token)(req);
      if (streamMatch) return json({ error: "Method not allowed" }, 405);
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
