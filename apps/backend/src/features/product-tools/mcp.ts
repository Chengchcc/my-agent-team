import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createProductToolsDispatch,
  type ProductToolsDispatch,
  type WireIdentity,
} from "./dispatch.js";
import type { RunTokenContext, RunTokenRegistry } from "./run-token-registry.js";
import type { ProductToolsService } from "./service.js";
export interface ProductToolsMcpServerOptions {
  readonly service: ProductToolsService;
  /** Per-run bearer registry — the ONLY accepted auth. A token validates
   *  only while its run is live (minted at dispatch, revoked at settle). */
  readonly tokenRegistry: RunTokenRegistry;
  readonly host?: string;
  /** 0 = ephemeral port. */
  readonly port?: number;
}

export interface ProductToolsMcpServer {
  /** Base URL the Oma Worker connects to (entrypoint `sse:<url>`). */
  readonly url: string;
  close(): Promise<void>;
}

function authorize(req: IncomingMessage, registry: RunTokenRegistry): RunTokenContext | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (scheme !== "Bearer" || value === undefined) return null;
  return registry.validate(value);
}

/** MCP layer only: protocol parsing, service-token authentication, input
 *  validation, and error normalization. Business logic lives in
 *  ProductToolsService. Serves the legacy SSE transport the Oma
 *  Worker's SSEClientTransport speaks. */
export async function createProductToolsMcpServer(
  opts: ProductToolsMcpServerOptions,
): Promise<ProductToolsMcpServer> {
  const { service, tokenRegistry } = opts;
  // Protocol shape, identity rules and tool list live in the dispatch shared
  // with the in-process (MCP-over-ACP) rail; this file is the SSE shell.
  const dispatch: ProductToolsDispatch = createProductToolsDispatch({ service });
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  /** One Server per SSE session. The session's bearer token is the identity:
   *  its run and agent scope every call, so nothing the model writes in the
   *  arguments can pick a different run (ADR 0036). */
  const makeServer = (caller: RunTokenContext): Server => {
    const s = new Server(
      { name: "product-tools", version: "1.0.0" },
      {
        capabilities: { tools: {} },
      },
    );

    s.setRequestHandler(ListToolsRequestSchema, async () => dispatch.listTools());

    s.setRequestHandler(CallToolRequestSchema, async (req) => {
      const metaIdentity = (req.params as { _meta?: { identity?: WireIdentity } })._meta?.identity;
      const result = await dispatch.call({
        caller: { runId: caller.runId, agentId: caller.agentId },
        name: req.params.name,
        args: (req.params.arguments ?? {}) as Record<string, unknown>,
        ...(metaIdentity ? { metaIdentity } : {}),
      });
      return {
        content: [{ type: "text", text: result.content }],
        ...(result.isError ? { isError: true as const } : {}),
      };
    });

    return s;
  };

  // SSE sessions: GET /sse establishes a stream (keyed by session id), POST
  // /messages delivers JSON-RPC for that session. Both require the token.
  // B1: each session binds the token's authenticated runId — a valid
  // bearer for run A can never act as run B through any session.
  const sessions = new Map<
    string,
    { transport: SSEServerTransport; authenticatedRunId: string; server: Server }
  >();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const caller = authorize(req, tokenRegistry);
    // Audit stamp: caller.runId is the authenticated run this request
    // belongs to (identity args are advisory; the bearer is the truth).
    if (!caller) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "unauthorized", message: "missing or invalid token" }));
      return;
    }
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      // B1: a dedicated Server per session — the handler closure pins the
      // authenticated runId, so identity forgery in tool args is rejected.
      const sessionServer = makeServer(caller);
      sessions.set(transport.sessionId, {
        transport,
        authenticatedRunId: caller.runId,
        server: sessionServer,
      });
      res.on("close", () => sessions.delete(transport.sessionId));
      await sessionServer.connect(transport).catch(() => undefined);
      return;
    }
    if (req.method === "POST" && url.startsWith("/messages")) {
      // SSEClientTransport posts to `/messages?sessionId=<id>`.
      const query = new URL(url, "http://localhost").searchParams.get("sessionId");
      const header = req.headers["mcp-session-id"];
      const sessionId = query ?? (typeof header === "string" ? header : undefined);
      const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (!session) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "invalid_request", message: "unknown session" }));
        return;
      }
      if (caller.runId !== session.authenticatedRunId) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ code: "unauthorized", message: "token does not own this session" }),
        );
        return;
      }
      await session.transport.handlePostMessage(req, res, undefined).catch(() => undefined);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "not_found", message: url }));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });
  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const baseUrl = `http://${host}:${actualPort}`;

  return {
    url: `${baseUrl}/sse`,
    close() {
      return new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        // force-close keep-alive connections after a grace tick
        setTimeout(() => httpServer.closeAllConnections(), 500);
      });
    },
  };
}
