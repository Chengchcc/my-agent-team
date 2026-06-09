import type { agentRoutes } from "../features/agent/http.js";
import type { checkpointRoutes } from "../features/checkpoint/http.js";
import type { conversationRoutes } from "../features/conversation/http.js";
import type { runRoutes } from "../features/run/http.js";
import type { threadRoutes } from "../features/thread/http.js";
import { HttpError } from "../infra/errors.js";
import { json } from "./response.js";
import { withAuth } from "./middleware.js";

interface FeatureSet {
  agents: ReturnType<typeof agentRoutes>;
  threads: ReturnType<typeof threadRoutes>;
  runs: ReturnType<typeof runRoutes>;
  checkpoints: ReturnType<typeof checkpointRoutes>;
  conversations?: ReturnType<typeof conversationRoutes>;
  /** H4: Legacy thread→conversation forwarding for POST /threads/:id/runs */
  resolveLegacyThreadRun?: (
    threadId: string,
  ) => Promise<
    | { action: "forward"; conversationId: string; agentMemberId: string }
    | { action: "reject"; reason: string }
    | null
  >;
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

  const { agents, threads, runs, checkpoints, conversations, resolveLegacyThreadRun } = features;

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
      const agentThreadsMatch = path.match(/^\/api\/agents\/([^/]+)\/threads$/);

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

      // Threads
      if (agentThreadsMatch && method === "POST")
        return withAuth((r) => threads.create(r, agentThreadsMatch[1]!), token)(req);
      if (agentThreadsMatch && method === "GET")
        return withAuth((r) => threads.list(r, agentThreadsMatch[1]!), token)(req);
      // M6: 405 for /api/agents/:id/threads with wrong method
      if (agentThreadsMatch) return json({ error: "Method not allowed" }, 405);

      const threadMatch = path.match(/^\/api\/threads\/([^/]+)$/);
      const threadMsgsMatch = path.match(/^\/api\/threads\/([^/]+)\/messages$/);
      const threadCurrentRunMatch = path.match(/^\/api\/threads\/([^/]+)\/current-run$/);
      const threadRunsMatch = path.match(/^\/api\/threads\/([^/]+)\/runs$/);

      if (threadMatch && method === "GET")
        return withAuth((r) => threads.getById(r, threadMatch[1]!), token)(req);
      if (threadMatch && method === "PATCH")
        return withAuth((r) => threads.update(r, threadMatch[1]!), token)(req);
      if (threadMatch && method === "DELETE")
        return withAuth((r) => threads.delete(r, threadMatch[1]!), token)(req);
      // M6: 405 for /api/threads/:id with wrong method
      if (threadMatch) return json({ error: "Method not allowed" }, 405);
      if (threadMsgsMatch && method === "GET")
        return withAuth((r) => checkpoints.getMessages(r, threadMsgsMatch[1]!), token)(req);
      if (threadMsgsMatch) return json({ error: "Method not allowed" }, 405);
      // D12: query active run for a thread
      if (threadCurrentRunMatch && method === "GET")
        return withAuth((r) => runs.currentRun(r, threadCurrentRunMatch[1]!), token)(req);
      if (threadCurrentRunMatch) return json({ error: "Method not allowed" }, 405);
      if (threadRunsMatch && method === "POST") {
        // H4: Legacy thread→conversation forwarding.
        // withAuth must wrap THE ENTIRE handler to prevent Bun from dropping
        // request headers on async calls that precede the auth check.
        return withAuth(async (req2: Request) => {
          if (resolveLegacyThreadRun) {
            const resolution = await resolveLegacyThreadRun(threadRunsMatch[1]!);
            if (resolution) {
              if (resolution.action === "forward" && conversations) {
                const body = (await req2.json().catch(() => ({}))) as { input?: string };
                // Already authenticated; conversations handler also checks auth
                return conversations.postMessage(
                  new Request(
                    `http://localhost/api/conversations/${resolution.conversationId}/messages`,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        senderMemberId: "legacy-user",
                        addressedTo: [resolution.agentMemberId],
                        content: { text: body.input ?? "" },
                      }),
                    },
                  ),
                  resolution.conversationId,
                );
              }
              if (resolution.action === "reject") {
                return json({ error: resolution.reason }, 400);
              }
            }
          }
          return runs.run(req2, threadRunsMatch[1]!);
        }, token)(req);
      }
      if (threadRunsMatch) return json({ error: "Method not allowed" }, 405);

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

        if (convListMatch && method === "POST")
          return withAuth((r) => conversations.create(r), token)(req);
        if (convListMatch) return json({ error: "Method not allowed" }, 405);
        if (convSnapMatch && method === "GET")
          return withAuth((r) => conversations.snapshot(r, convSnapMatch[1]!), token)(req);
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
