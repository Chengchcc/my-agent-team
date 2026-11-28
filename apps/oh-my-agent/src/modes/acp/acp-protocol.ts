import { Readable, Writable } from "node:stream";
import type { RequestPermissionResponse, Usage as SdkUsage } from "@agentclientprotocol/sdk";
import * as acp from "@agentclientprotocol/sdk";
import { adaptMcpTool } from "@chengchenccc/adapter-mcp";
import type { ContentBlock, Message } from "@chengchenccc/message";
import {
  type ApprovalDecision,
  type ApprovalHandler,
  approvalTimeoutMs,
} from "../../core/runtime/approval.js";
import type { RunEventEnvelope } from "../../protocol/index.js";

/** A client-declared MCP server carried over the ACP connection itself
 *  (RFCD "MCP-over-ACP"; the SDK's McpServerAcp declaration shape). */
export interface AcpMcpServerDeclaration {
  readonly name: string;
  readonly serverId: string;
}

/** The client declares its permission policy over the extension vehicle
 *  (`_meta["my-agent-team/permissionMode"]`, the same convention as resume). */
export type DeclaredPermissionMode = "ask" | "auto" | "deny" | "yolo";

export function readPermissionMode(
  meta: Record<string, unknown> | null | undefined,
): DeclaredPermissionMode {
  const raw = meta?.["my-agent-team/permissionMode"];
  return raw === "auto" || raw === "deny" || raw === "yolo" || raw === "ask" ? raw : "ask";
}

/** Authoritative host/product system prompt passed over ACP `_meta`
 *  (ADR 0039 extension-vehicle rule 2). Absent for external ACP clients. */
export function readSystemPrompt(meta: Record<string, unknown> | null | undefined): string | null {
  const raw = meta?.["my-agent-team/systemPrompt"];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/** Product-assigned skill pack roots passed over ACP `_meta`. */
export function readSkillRoots(meta: Record<string, unknown> | null | undefined): string[] {
  const raw = meta?.["my-agent-team/skillRoots"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

export interface ResumeDecision {
  readonly callId: string;
  readonly kind: "approval" | "ask";
  readonly response: Record<string, unknown>;
}

export interface AcpSessionRef {
  readonly sessionId: string;
  readonly acpMcpServers: readonly AcpMcpServerDeclaration[];
}

export const STEER_METHOD = "_session/steering";
export const MODEL_CONFIG_ID = "model";
export const OMA_UPDATE_METHOD = "_oma/update";

/** The session's model as an ACP config option: the catalog is the source of
 *  truth (the same one `oma --list-models` prints) and values are the
 *  canonical `provider/model` ids. */
export function modelConfigOptions(
  catalog: { models: readonly { providerId: string; modelId: string }[] },
  chosen: string | null,
  fallback: string | null | undefined,
) {
  const options = catalog.models.map((entry) => {
    const id = `${entry.providerId}/${entry.modelId}`;
    return { value: id, name: id };
  });
  const wanted = chosen ?? fallback ?? null;
  const effective = catalog.models.find((m) => `${m.providerId}/${m.modelId}` === wanted);
  const currentValue = effective
    ? `${effective.providerId}/${effective.modelId}`
    : (options[0]?.value ?? "");
  return [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      description: "Select the model for this session",
      category: "model" as const,
      type: "select" as const,
      currentValue,
      options,
    },
  ];
}

/** The client's `mcpServers` entries of type "acp" (RFCD declaration). */
export function readAcpMcpServers(mcpServers: unknown): AcpMcpServerDeclaration[] {
  if (!Array.isArray(mcpServers)) return [];
  const servers: AcpMcpServerDeclaration[] = [];
  for (const entry of mcpServers) {
    const server = entry as { type?: unknown; name?: unknown; serverId?: unknown };
    if (
      server?.type === "acp" &&
      typeof server.name === "string" &&
      typeof server.serverId === "string"
    ) {
      servers.push({ name: server.name, serverId: server.serverId });
    }
  }
  return servers;
}

/** The per-request MCP metadata the RFCD requires on every inner call. */
const ACP_MCP_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "oma", version: "1" },
} as const;

let acpMcpRequestSeq = 0;
const DEFAULT_ACP_MCP_TIMEOUT_MS = 120_000;

function acpMcpTimeoutMs(): number {
  const raw = process.env.OMA_MCP_TIMEOUT_MS;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_ACP_MCP_TIMEOUT_MS;
}

/** One `mcp/message` round trip (RFCD envelope: serverId + logical
 *  requestId + flattened method/params). Bounded by timeout + AbortSignal
 *  so a hung product tool never wedges the loop indefinitely. */
export async function acpMcpCall(
  client: acp.AgentContext,
  serverId: string,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) {
    throw new Error(`mcp/${method} aborted`);
  }
  const requestId = `oma-mcp-${++acpMcpRequestSeq}`;
  const reqPromise = client.request("mcp/message", {
    serverId,
    requestId,
    method,
    params: {
      ...params,
      _meta: { ...ACP_MCP_META, ...((params._meta as Record<string, unknown> | undefined) ?? {}) },
    },
  } as never) as Promise<{ result?: { result?: unknown; error?: { message?: string } } }>;

  const timeoutMs = acpMcpTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const response = await new Promise<{
    result?: { result?: unknown; error?: { message?: string } };
  }>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`mcp/${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    if (signal) {
      onAbort = () => reject(new Error(`mcp/${method} aborted`));
      signal.addEventListener("abort", onAbort, { once: true });
    }
    reqPromise.then(resolve, reject);
  }).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  });

  const inner = response.result;
  if (inner?.error) {
    throw new Error(`mcp/${method} failed: ${inner.error.message ?? "unknown error"}`);
  }
  return inner?.result;
}

/** Extract clean text + isError from an MCP tools/call result so MCP-over-ACP
 *  never double-JSON-encodes `{ content: [{ type: "text", text }] }` or drops
 *  `isError: true`. */
export function unwrapMcpCallResult(raw: unknown): { content: unknown; isError?: boolean } {
  if (typeof raw !== "object" || raw === null) {
    return { content: raw };
  }
  const rec = raw as { content?: unknown; isError?: unknown };
  const isError = rec.isError === true;
  if (Array.isArray(rec.content)) {
    const blocks = rec.content as Array<{ type?: unknown; text?: unknown }>;
    if (
      blocks.length > 0 &&
      blocks.every((b) => b?.type === "text" && typeof b.text === "string")
    ) {
      return {
        content: blocks.map((b) => b.text as string).join("\n"),
        ...(isError ? { isError: true } : {}),
      };
    }
    return { content: rec.content, ...(isError ? { isError: true } : {}) };
  }
  if ("content" in rec) {
    return { content: rec.content, ...(isError ? { isError: true } : {}) };
  }
  return { content: raw, ...(isError ? { isError: true } : {}) };
}

/** Fetch every declared ACP MCP server's tools, adapted into oma tools. */
export async function fetchAcpMcpTools(
  client: acp.AgentContext,
  session: AcpSessionRef,
  log: (line: string) => void,
): Promise<ReturnType<typeof adaptMcpTool>[]> {
  const tools: ReturnType<typeof adaptMcpTool>[] = [];
  for (const server of session.acpMcpServers) {
    try {
      const listed = (await acpMcpCall(client, server.serverId, "tools/list", {})) as {
        tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
      };
      for (const tool of listed?.tools ?? []) {
        tools.push(
          adaptMcpTool(server.name, tool, {
            callTool: async ({ name, arguments: args, _meta, signal }) => {
              const raw = await acpMcpCall(
                client,
                server.serverId,
                "tools/call",
                {
                  name,
                  arguments: args,
                  ...(_meta ? { _meta } : {}),
                },
                signal,
              );
              return unwrapMcpCallResult(raw);
            },
          }),
        );
      }
      log(`[acp] mcp-over-acp ${server.name}: ${listed?.tools?.length ?? 0} tools`);
    } catch (err) {
      log(`[acp] mcp-over-acp ${server.name} failed: ${String(err)}`);
    }
  }
  return tools;
}

export function parseSteerParams(raw: unknown): { sessionId: string; text: string } {
  const params = raw as { sessionId?: unknown; prompt?: unknown };
  const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "";
  const text = promptMessageOf(params?.prompt).text ?? "";
  if (!sessionId || !text) {
    throw acp.RequestError.invalidParams(
      undefined,
      "_session/steering requires sessionId and prompt",
    );
  }
  return { sessionId, text };
}

/** ACP prompt blocks → a user Message (#65, break 2). */
export function promptMessageOf(prompt: unknown): Message {
  const texts: string[] = [];
  const blocks: ContentBlock[] = [];
  const push = (block: unknown): void => {
    if (typeof block !== "object" || block === null) return;
    const { type } = block as { type?: string };
    if (type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") texts.push(text);
    } else if (type === "image") {
      const { data, mimeType } = block as { data?: unknown; mimeType?: unknown };
      if (
        typeof data === "string" &&
        (mimeType === "image/png" ||
          mimeType === "image/jpeg" ||
          mimeType === "image/gif" ||
          mimeType === "image/webp")
      ) {
        blocks.push({ type: "image", mediaType: mimeType, base64: data });
      }
    }
  };
  if (typeof prompt === "string") {
    texts.push(prompt);
  } else if (Array.isArray(prompt)) {
    for (const block of prompt) push(block);
  }
  const message: Message = { role: "user", text: texts.join("") };
  if (blocks.length > 0) message.blocks = blocks;
  return message;
}

/** The namespaced resume envelope: an optional `adopt` declaration and the
 *  replayed decisions (ADR 0039 extension-vehicle rule 2). */
export function readResumeMeta(meta: Record<string, unknown> | null | undefined): {
  adopt?: string;
  decisions: ResumeDecision[] | null;
} | null {
  const raw = meta?.["my-agent-team/resume"] as
    | { adopt?: unknown; decisions?: unknown }
    | undefined;
  if (!raw) return null;
  return {
    ...(typeof raw.adopt === "string" ? { adopt: raw.adopt } : {}),
    decisions: parseDecisions(raw.decisions),
  };
}

export function readResumeDecisions(
  meta: Record<string, unknown> | null | undefined,
): ResumeDecision[] | null {
  return readResumeMeta(meta)?.decisions ?? null;
}

function parseDecisions(decisions: unknown): ResumeDecision[] | null {
  if (!Array.isArray(decisions)) return null;
  const parsed: ResumeDecision[] = [];
  for (const decision of decisions) {
    const entry = decision as { callId?: unknown; kind?: unknown; response?: unknown };
    if (
      typeof entry?.callId === "string" &&
      (entry?.kind === "approval" || entry?.kind === "ask") &&
      typeof entry?.response === "object" &&
      entry.response !== null
    ) {
      parsed.push({
        callId: entry.callId,
        kind: entry.kind,
        response: entry.response as Record<string, unknown>,
      });
    }
  }
  return parsed.length > 0 ? parsed : null;
}

export function resumeApprovals(
  resume: readonly ResumeDecision[] | null,
): Map<string, ApprovalDecision> {
  const map = new Map<string, ApprovalDecision>();
  for (const decision of resume ?? []) {
    if (
      decision.kind === "approval" &&
      (decision.response as { decision?: unknown }).decision === "allow"
    ) {
      map.set(decision.callId, {
        decision: "allow",
        reason: "human decision replayed into the resumed run (ADR 0038)",
      });
    }
  }
  return map;
}

export function toolKindFor(toolName: string): string {
  if (toolName === "bash") return "execute";
  if (toolName === "read" || toolName === "glob") return "read";
  if (toolName === "write" || toolName === "edit") return "edit";
  if (toolName === "grep") return "search";
  if (toolName === "browser" || toolName === "web_search") return "fetch";
  return "other";
}

export type MappedWireEvent = { update: object } | { oma: unknown };

/** Wire event envelope → either a standard session/update payload or an
 *  oma-private blob for the `_oma/update` custom notification. */
export function mapWireEvent(envelope: RunEventEnvelope): MappedWireEvent[] {
  const data = envelope.data as Record<string, unknown>;
  const text = typeof data.text === "string" ? data.text : "";
  switch (envelope.type) {
    case "message_update":
      return [
        { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
      ];
    case "thinking_update":
      return [
        { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } } },
      ];
    case "tool_execution_start": {
      const toolName = typeof data.toolName === "string" ? data.toolName : "unknown";
      const callId = typeof data.callId === "string" ? data.callId : "";
      if (!callId) return [];
      const activity = typeof data.activity === "string" ? data.activity : undefined;
      return [
        {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: callId,
            name: toolName,
            title: activity ?? toolName,
            kind: toolKindFor(toolName),
            status: "pending",
            ...(data.input !== undefined ? { rawInput: data.input } : {}),
          },
        },
      ];
    }
    case "tool_execution_end": {
      const callId = typeof data.callId === "string" ? data.callId : "";
      if (!callId) return [];
      const result = data.result;
      const failed = data.isError === true;
      return [
        {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: callId,
            status: failed ? "failed" : "completed",
            ...(result !== undefined && result !== null && typeof result === "object"
              ? { rawOutput: result }
              : {}),
          },
        },
      ];
    }
    case "todo_update": {
      const items = Array.isArray(data.items)
        ? (data.items as { text?: unknown; status?: unknown }[])
        : [];
      return [
        {
          update: {
            sessionUpdate: "plan",
            entries: items.map((item) => ({
              content: typeof item.text === "string" ? item.text : "",
              priority: "medium",
              status:
                item.status === "done"
                  ? "completed"
                  : item.status === "in_progress"
                    ? "in_progress"
                    : "pending",
            })),
          },
        },
      ];
    }
    case "tool_output":
      return [];
    default:
      return [{ oma: envelope }];
  }
}

export function toAcpUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): SdkUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(usage.cacheReadTokens !== undefined ? { cachedReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cachedWriteTokens: usage.cacheWriteTokens } : {}),
  } as SdkUsage;
}

export function processStream(): ReturnType<typeof acp.ndJsonStream> {
  return acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  );
}

const SANDBOXED_META_KEY = "my-agent-team/sandboxed";

/** The approval gate as an ACP permission request: park the resolver, fail
 *  closed at the deadline, map the client's chosen optionId back to
 *  allow/deny. */
export function acpApproval(
  client: acp.AgentContext,
  session: AcpSessionRef,
  req: Parameters<ApprovalHandler>[0],
  pendingApprovals: Map<string, (d: ApprovalDecision) => void>,
): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (d: ApprovalDecision): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      pendingApprovals.delete(req.callId);
      resolve(d);
    };
    pendingApprovals.set(req.callId, settle);
    void client
      .request(acp.methods.client.session.requestPermission, {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: req.callId,
          name: req.toolName,
          title: req.reason ?? `${req.toolName} needs approval`,
          kind: toolKindFor(req.toolName),
          status: "pending",
          ...(req.input !== undefined ? { rawInput: req.input } : {}),
          ...(req.sandboxed !== undefined
            ? { _meta: { [SANDBOXED_META_KEY]: req.sandboxed } }
            : {}),
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          {
            optionId: "allow-always",
            name: "Allow this tool for the rest of the run",
            kind: "allow_always",
          },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          {
            optionId: "reject-always",
            name: "Reject this tool for the rest of the run",
            kind: "reject_always",
          },
        ],
      } as never)
      .then(
        (response: RequestPermissionResponse) => {
          if (response.outcome.outcome !== "selected") {
            settle({ decision: "deny", reason: "client cancelled the request" });
            return;
          }
          const chosen = response.outcome.optionId;
          if (chosen === "allow-always") {
            settle({ decision: "allow_always" });
            return;
          }
          if (chosen === "reject-always") {
            settle({ decision: "deny_always", reason: "denied for this run by the user" });
            return;
          }
          const allowed = chosen === "allow-once";
          settle({
            decision: allowed ? "allow" : "deny",
            ...(allowed ? {} : { reason: "denied by the client" }),
          });
        },
        (err: unknown) => {
          settle({ decision: "deny", reason: `permission request failed: ${String(err)}` });
        },
      );
    const timeoutMs =
      req.deadlineAt === undefined ? approvalTimeoutMs() : Math.max(1, req.deadlineAt - Date.now());
    if (timeoutMs > 0) {
      timer = setTimeout(
        () => settle({ decision: "deny", reason: "approval deadline exceeded" }),
        timeoutMs,
      );
      timer.unref?.();
    }
  });
}
