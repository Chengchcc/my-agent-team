import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentConfigEventBus } from "./agent-config-events.js";

/** Agent-config MCP server: lets a chat agent read/write an agent's config
 *  through ordinary MCP tools. This is how the agent edit page's chat
 *  proposes config changes — `agent_write` emits a "changed" SSE event with
 *  the proposed config; the left form adopts it as an unsaved edit and the
 *  user commits it with Save. The live agent.yml is never touched until the
 *  user saves (mirrors the workflow editor's propose→review→save cadence).
 *
 *  Bound to 127.0.0.1; tools are narrow reads/writes scoped to one agent id. */

export interface AgentConfigMcpServerOptions {
  /** Read the current agent config (from the service cache) by id. */
  readonly readConfig: (agentId: string) => Promise<unknown>;
  /** Required: without it agent_write would report a proposal for an id that
   *  has no edit page to adopt it — a false success. */
  readonly agentExists: (agentId: string) => Promise<boolean>;
  readonly host?: string;
  /** 0 = ephemeral port. */
  readonly port?: number;
  /** Emit a "changed" event after agent_write (SSE live refresh). */
  readonly configEvents?: AgentConfigEventBus;
}

/** One tool call, transport-free. Throws on a bad call — the MCP layer maps
 *  that to isError. Exported so the semantics stay testable without an SSE
 *  round trip. */
export async function callAgentConfigTool(
  deps: {
    readConfig: (agentId: string) => Promise<unknown>;
    agentExists: (agentId: string) => Promise<boolean>;
    configEvents?: AgentConfigEventBus;
  },
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const agentId = typeof args.agentId === "string" ? args.agentId : "";
  if (!agentId) throw new Error("agentId required");
  if (name === "agent_read") {
    return JSON.stringify(await deps.readConfig(agentId), null, 2);
  }
  if (name === "agent_write") {
    if (typeof args.config !== "object" || args.config === null) {
      throw new Error("config (object) required");
    }
    // No agent row = no workspace, no run, and no edit page to adopt the
    // proposal: reporting success there is a lie the model would relay.
    if (!(await deps.agentExists(agentId))) {
      throw new Error(
        `unknown agent: ${agentId} — this tool proposes changes to an EXISTING agent; create the agent on the Team page first`,
      );
    }
    // NO file write. The proposed config is pushed to the edit page over the
    // agent-config SSE; the form shows it as an unsaved edit and the user
    // commits it with Save. The live agent.yml is untouched.
    deps.configEvents?.emit(agentId, { trigger: "mcp", config: args.config });
    return `proposed update for ${agentId} (${randomUUID().slice(0, 8)}) — NOT saved: open /team/${agentId}/edit, review the unsaved change and Save to apply`;
  }
  throw new Error(`unknown tool: ${name}`);
}

export interface AgentConfigMcpServer {
  /** SSE base URL (the entrypoint a child mounts as `sse:<url>`). */
  readonly url: string;
  close(): Promise<void>;
}

export async function createAgentConfigMcpServer(
  opts: AgentConfigMcpServerOptions,
): Promise<AgentConfigMcpServer> {
  const { readConfig, configEvents } = opts;
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;

  const makeServer = (): Server => {
    const s = new Server(
      { name: "agent-config", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    s.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "agent_read",
          description:
            "Read an agent's current config by its id. Returns the agent config object (agent.yml shape).",
          inputSchema: {
            type: "object",
            properties: { agentId: { type: "string" } },
            required: ["agentId"],
          },
        },
        {
          name: "agent_write",
          description:
            "Propose a new config for an EXISTING agent by its id. The edit page (/team/<id>/edit) adopts it as an unsaved edit; the user commits with Save. Never writes agent.yml directly and cannot create agents.",
          inputSchema: {
            type: "object",
            properties: {
              agentId: { type: "string" },
              config: { type: "object" },
            },
            required: ["agentId", "config"],
          },
        },
      ],
    }));

    s.setRequestHandler(CallToolRequestSchema, async (req) => {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      try {
        const text = await callAgentConfigTool(
          { readConfig, agentExists: opts.agentExists, configEvents },
          req.params.name,
          args,
        );
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    });
    return s;
  };

  const sessions = new Map<string, { transport: SSEServerTransport; server: Server }>();
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      const sessionServer = makeServer();
      sessions.set(transport.sessionId, { transport, server: sessionServer });
      res.on("close", () => sessions.delete(transport.sessionId));
      await sessionServer.connect(transport).catch(() => undefined);
      return;
    }
    if (req.method === "POST" && url.startsWith("/messages")) {
      const query = new URL(url, "http://localhost").searchParams.get("sessionId");
      const header = req.headers["mcp-session-id"];
      const sessionId = query ?? (typeof header === "string" ? header : undefined);
      const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (!session) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "invalid_request", message: "unknown session" }));
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
        setTimeout(() => httpServer.closeAllConnections(), 500);
      });
    },
  };
}
