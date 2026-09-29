import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { BACKEND_KINDS } from "@chengchenccc/agent-contract";
import { AGENT_DRAFT_ID } from "@chengchenccc/api-contract";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentConfigEventBus } from "./agent-config-events.js";

/** Agent-config MCP server: lets a chat agent read/write/create agents
 *  through ordinary MCP tools. This is how the agent edit page's chat
 *  proposes config changes — `agent_write` emits a "changed" SSE event with
 *  the proposed config; the left form adopts it as an unsaved edit and the
 *  user commits it with Save. The live agent.yml is never touched until the
 *  user saves (mirrors the workflow editor's propose→review→save cadence).
 *  `agent_create` is the exception: it CREATES for real, through the agent
 *  service, because a brand-new agent has no workspace, no row and no edit
 *  page for a proposal to land in.
 *
 *  Bound to 127.0.0.1; tools are narrow reads/writes scoped to one agent id. */

/** The create subset the MCP tool accepts. Deliberately smaller than the
 *  HTTP create body: no workspacePath/mcpServers/knowledgePacks (they need
 *  ids a model cannot validate) and no `id` (the service mints one, exactly
 *  like the HTTP route). */
export interface AgentProxyCreateInput {
  name: string;
  model: { provider: string; model: string };
  backendKind?: string;
  reasoningEffort?: "none" | "low" | "high" | "max";
  permissionMode?: "ask" | "auto" | "deny";
}

export interface AgentCreateBudget {
  readonly max: number;
  readonly windowMs: number;
}

/** A model in a loop can mint agents faster than a human can delete them.
 *  Five per ten minutes is far above any honest request and far below a
 *  runaway; the counter is per process (one backend = one counter). */
export const DEFAULT_AGENT_CREATE_BUDGET: AgentCreateBudget = { max: 5, windowMs: 10 * 60_000 };

/** Returns the "spend one create" guard: throws once the window is spent and
 *  refills when the window rolls over. */
export function createCreateBudget(
  budget: AgentCreateBudget = DEFAULT_AGENT_CREATE_BUDGET,
): () => void {
  let windowStart = Date.now();
  let used = 0;
  return () => {
    const now = Date.now();
    if (now - windowStart >= budget.windowMs) {
      windowStart = now;
      used = 0;
    }
    if (used >= budget.max) {
      throw new Error(
        `agent create budget spent (${budget.max} per ${Math.round(budget.windowMs / 60_000)}min) — ask the user to create agents in the Team page`,
      );
    }
    used++;
  };
}

export interface AgentConfigMcpDeps {
  /** Read the current agent config (from the service cache) by id. */
  readonly readConfig: (agentId: string) => Promise<unknown>;
  /** Required: without it agent_write would report a proposal for an id that
   *  has no edit page to adopt it — a false success. */
  readonly agentExists: (agentId: string) => Promise<boolean>;
  /** Create through the agent service (row + workspace + onCreate chain).
   *  Never a file write: a hand-made workspace dir is invisible to list(). */
  readonly createAgent: (input: AgentProxyCreateInput) => Promise<{ id: string }>;
  /** Spend-guard for agent_create; throws when the budget is exhausted. */
  readonly reserveCreate: () => void;
  /** Emit a "changed" event after agent_write (SSE live refresh). */
  readonly configEvents?: AgentConfigEventBus;
}

export interface AgentConfigMcpServerOptions extends Omit<AgentConfigMcpDeps, "reserveCreate"> {
  readonly host?: string;
  /** 0 = ephemeral port. */
  readonly port?: number;
  /** Test seam; defaults to the process-wide create budget. */
  readonly reserveCreate?: () => void;
}

/** Trimmed non-empty string, or null. */
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Narrow the model's agent_create arguments. Throws on anything unusable so
 *  the mistake comes back as a tool error instead of a half-created agent. */
export function readAgentCreateInput(args: Record<string, unknown>): AgentProxyCreateInput {
  const name = str(args.name);
  if (!name) throw new Error("name required");
  const model = typeof args.model === "object" && args.model !== null ? args.model : null;
  const provider = model && "provider" in model ? str(model.provider) : null;
  const modelName = model && "model" in model ? str(model.model) : null;
  if (!provider || !modelName) {
    throw new Error(
      'model required, e.g. { "provider": "anthropic", "model": "claude-sonnet-4-6" }',
    );
  }
  const rawKind = str(args.backendKind);
  const backendKind = BACKEND_KINDS.find((kind) => kind === rawKind);
  if (rawKind && !backendKind) {
    throw new Error(`backendKind must be one of ${BACKEND_KINDS.join(", ")}`);
  }
  const EFFORTS = ["none", "low", "high", "max"] as const;
  const reasoningEffort = EFFORTS.find((e) => e === str(args.reasoningEffort));
  if (str(args.reasoningEffort) && !reasoningEffort) {
    throw new Error(`reasoningEffort must be one of ${EFFORTS.join(", ")}`);
  }
  const MODES = ["ask", "auto", "deny"] as const;
  const permissionMode = MODES.find((m) => m === str(args.permissionMode));
  if (str(args.permissionMode) && !permissionMode) {
    throw new Error(`permissionMode must be one of ${MODES.join(", ")}`);
  }
  return {
    name,
    model: { provider, model: modelName },
    ...(backendKind ? { backendKind } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(permissionMode ? { permissionMode } : {}),
  };
}

/** One tool call, transport-free. Throws on a bad call — the MCP layer maps
 *  that to isError. Exported so the semantics stay testable without an SSE
 *  round trip. */
export async function callAgentConfigTool(
  deps: AgentConfigMcpDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (name === "agent_create") {
    const input = readAgentCreateInput(args);
    deps.reserveCreate();
    // Through the agent service, like the HTTP route: materialize the
    // workspace, write agent.yml, insert the row and run onCreate (builtin
    // skill pack + workspace reconcile). A file write would create a ghost.
    const row = await deps.createAgent(input);
    const runtime = input.backendKind ? `, runtime ${input.backendKind}` : "";
    return `created agent "${input.name}" (id: ${row.id}) — model ${input.model.provider}/${input.model.model}${runtime}. It carries the builtin skills; the user can refine it at /team/${row.id}/edit`;
  }
  const agentId = typeof args.agentId === "string" ? args.agentId : "";
  if (!agentId) throw new Error("agentId required");
  if (name === "agent_read") {
    return JSON.stringify(await deps.readConfig(agentId), null, 2);
  }
  if (name === "agent_write") {
    if (typeof args.config !== "object" || args.config === null) {
      throw new Error("config (object) required");
    }
    // The create page binds its chat to AGENT_DRAFT_ID: no agent row exists
    // yet, only the form that adopts this proposal.
    const isDraft = agentId === AGENT_DRAFT_ID;
    // No agent row = no workspace, no run, and no edit page to adopt the
    // proposal: reporting success there is a lie the model would relay.
    if (!isDraft && !(await deps.agentExists(agentId))) {
      throw new Error(
        `unknown agent: ${agentId} — this tool proposes changes to an EXISTING agent; create it with agent_create or on the Team page first`,
      );
    }
    // NO file write. The proposed config is pushed to the edit page (or the
    // create page's form for the draft id) over the agent-config SSE; the
    // form shows it as an unsaved edit and the user commits it with Save.
    deps.configEvents?.emit(agentId, { trigger: "mcp", config: args.config });
    const id8 = randomUUID().slice(0, 8);
    return isDraft
      ? `proposed a new-agent config (${id8}) — NOT created: the create page (/team/new/edit) filled its form, and the user commits it with Create`
      : `proposed update for ${agentId} (${id8}) — NOT saved: open /team/${agentId}/edit, review the unsaved change and Save to apply`;
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
  const { readConfig, agentExists, createAgent, configEvents } = opts;
  const reserveCreate = opts.reserveCreate ?? createCreateBudget();
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
          name: "agent_create",
          description:
            'Create a NEW agent (a teammate) for the user: real agent row + workspace + builtin skills. Use it when the user asks for another agent and is NOT on the create page; pass a display name and the model to run it on (take your own from the Workspace system reminder if the user has no preference). On the create page (agentId "new") use agent_write with agentId "new" instead, so the user reviews the form before anything is created.',
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Display name, e.g. Code Reviewer." },
              model: {
                type: "object",
                properties: {
                  provider: { type: "string" },
                  model: { type: "string" },
                },
                required: ["provider", "model"],
                description:
                  'Canonical model pair, e.g. { "provider": "anthropic", "model": "claude-sonnet-4-6" }.',
              },
              backendKind: {
                type: "string",
                enum: [...BACKEND_KINDS],
                description: "Runtime backend (default oma).",
              },
              reasoningEffort: { type: "string", enum: ["none", "low", "high", "max"] },
              permissionMode: {
                type: "string",
                enum: ["ask", "auto", "deny"],
                description: "Tool-approval posture (default ask; auto = classifier-gated).",
              },
            },
            required: ["name", "model"],
          },
        },
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
            'Propose a config: for an EXISTING agent by its id (the edit page /team/<id>/edit adopts it as an unsaved edit), or for a new agent with agentId "new" (the create page /team/new/edit fills its form). The user commits with Save/Create. Never writes agent.yml directly.',
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
          { readConfig, agentExists, createAgent, reserveCreate, configEvents },
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
