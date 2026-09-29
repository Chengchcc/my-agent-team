import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { join } from "node:path";
import { parseWorkflow } from "@chengchenccc/workflow";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { WorkflowDefinitionEventBus } from "./definition-events.js";

/** Workflow DSL MCP server: the ONLY way a Run reads or changes a workflow
 *  definition. Definitions live at `<workflowDir>/<id>.workflow.json` —
 *  outside every agent workspace, so the file tools refuse them. The agent
 *  calls workflow_read for the current JSON and workflow_write with a full
 *  validated replacement, which the editor adopts as an unsaved change.
 *
 *  Reuses the SSE transport shape from product-tools (the Oma Worker's
 *  SSEClientTransport speaks it). No per-run bearer here: the server is
 *  bound to 127.0.0.1 and the tools are narrow file operations scoped to
 *  the workflow dir. */

export interface WorkflowMcpServerOptions {
  /** Directory holding `*.workflow.json` files. */
  readonly workflowDir: string;
  readonly host?: string;
  /** 0 = ephemeral port. */
  readonly port?: number;
  /** Emit a "changed" event after workflow_write (SSE live refresh). */
  readonly definitionEvents?: WorkflowDefinitionEventBus;
}

export interface WorkflowMcpServer {
  /** SSE base URL (the entrypoint a child mounts as `sse:<url>`). */
  readonly url: string;
  close(): Promise<void>;
}

function safePath(workflowDir: string, workflowId: string): string {
  // Reject traversal: the id is a bare filename stem.
  if (!/^[A-Za-z0-9._-]+$/.test(workflowId)) {
    throw new Error(`invalid workflow id: ${workflowId}`);
  }
  return join(workflowDir, `${workflowId}.workflow.json`);
}

/** One tool call, transport-free. Throws on a bad call — the MCP layer maps
 *  that to isError. Exported so the semantics stay testable without an SSE
 *  round trip. */
export function callWorkflowTool(
  deps: { workflowDir: string; definitionEvents?: WorkflowDefinitionEventBus },
  name: string,
  args: Record<string, unknown>,
): string {
  const workflowId = typeof args.workflowId === "string" ? args.workflowId : "";
  if (name === "workflow_read") {
    if (!workflowId) throw new Error("workflowId required");
    return readFileSync(safePath(deps.workflowDir, workflowId), "utf8");
  }
  if (name === "workflow_write") {
    if (!workflowId) throw new Error("workflowId required");
    if (typeof args.definition !== "object" || args.definition === null) {
      throw new Error("definition (object) required");
    }
    // Same trust boundary as the HTTP PUT: a proposal the editor would refuse
    // on Save must be a failed tool call, not a silent no-op the model only
    // discovers a round trip later.
    parseWorkflow(args.definition);
    // NO file write. The agent's proposed DSL is pushed to the editor over the
    // definition SSE; the editor shows it as an unsaved edit and the user
    // commits it with (Ctrl/Cmd)S. The live file is never touched until then.
    deps.definitionEvents?.emit(workflowId, { trigger: "mcp", definition: args.definition });
    return `proposed update for ${workflowId} (${randomUUID().slice(0, 8)}) — NOT saved: the editor holds it as an unsaved change and the user applies it with Ctrl/Cmd+S`;
  }
  throw new Error(`unknown tool: ${name}`);
}

export async function createWorkflowMcpServer(
  opts: WorkflowMcpServerOptions,
): Promise<WorkflowMcpServer> {
  const { workflowDir, definitionEvents } = opts;
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  mkdirSync(workflowDir, { recursive: true });

  const makeServer = (): Server => {
    const s = new Server({ name: "workflow", version: "1.0.0" }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "workflow_read",
          description:
            "Read a workflow definition by its id (filename stem, e.g. nighttime-report). Workflow files live outside the agent workspace, so the file tools cannot reach them — use this.",
          inputSchema: {
            type: "object",
            properties: { workflowId: { type: "string" } },
            required: ["workflowId"],
          },
        },
        {
          name: "workflow_write",
          description:
            "Propose a full replacement definition for a workflow (validated by parseWorkflow). NOT persisted: the editor holds it as an unsaved change and the user applies it with Ctrl/Cmd+S.",
          inputSchema: {
            type: "object",
            properties: {
              workflowId: { type: "string" },
              definition: { type: "object" },
            },
            required: ["workflowId", "definition"],
          },
        },
      ],
    }));

    s.setRequestHandler(CallToolRequestSchema, async (req) => {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      try {
        const text = callWorkflowTool({ workflowDir, definitionEvents }, req.params.name, args);
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
