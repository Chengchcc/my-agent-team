import { randomUUID } from "node:crypto";
import { pendingActionId } from "../agent-run/domain.js";
import type { ProductToolsService } from "./service.js";

/** Wire identity the child attaches to a call (`_meta.identity` on the MCP
 *  call): run/conversation/branch/callId copied out of its system prompt. */
export interface WireIdentity {
  runId?: unknown;
  conversationId?: unknown;
  agentId?: unknown;
  branchId?: unknown;
  callId?: unknown;
  idempotencyKey?: unknown;
}

/** Protocol-neutral shape of one product tool. The MCP layer wraps it into
 *  MCP content blocks; an in-process rail (MCP-over-ACP) hands the same
 *  objects over its own envelope. */
export interface ProductToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** The caller's authenticated scope. Every rail derives it from ITS OWN
 *  authority (an SSE bearer token, an ACP session's run) — never from
 *  tool arguments. */
export interface ProductToolsCaller {
  readonly runId: string;
  readonly agentId: string;
}

export interface ProductToolsCallRequest {
  readonly caller: ProductToolsCaller;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** The child's OWN wire identity when the rail carries one. A mismatch
   *  against the authenticated run means a crossed process and rejects. */
  readonly metaIdentity?: WireIdentity;
}

export interface ProductToolsCallResult {
  readonly content: string;
  readonly isError?: boolean;
}

/** The dispatch both rails share: which tools exist, and how one call is
 *  authorized, keyed and normalized. Business logic stays in
 *  ProductToolsService. */
export interface ProductToolsDispatch {
  listTools(): { readonly tools: readonly ProductToolDescriptor[] };
  call(req: ProductToolsCallRequest): Promise<ProductToolsCallResult>;
}

const IDENTITY_SCHEMA = {
  type: "object",
  properties: {
    runId: { type: "string" },
    conversationId: { type: "string" },
    agentId: { type: "string" },
    branchId: { type: "string" },
  },
};

export const PRODUCT_TOOLS: readonly ProductToolDescriptor[] = [
  {
    name: "history_recent",
    description:
      "Read the most recent messages visible to this agent member in the conversation. Pass the identity from the system prompt.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" }, identity: IDENTITY_SCHEMA },
    },
  },
  {
    name: "history_search",
    description: "Search the conversation ledger for messages matching a keyword.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        limit: { type: "number" },
        identity: IDENTITY_SCHEMA,
      },
      required: ["keyword"],
    },
  },
  {
    name: "history_around",
    description: "Read messages around a ledger seq in this conversation.",
    inputSchema: {
      type: "object",
      properties: {
        seq: { type: "number" },
        before: { type: "number" },
        after: { type: "number" },
        identity: IDENTITY_SCHEMA,
      },
      required: ["seq"],
    },
  },
  {
    name: "history_retain",
    description:
      "Pin a conversation message into this agent's context branch. Semantic mutation; replay-safe.",
    inputSchema: {
      type: "object",
      properties: {
        seq: { type: "number" },
        reason: { type: "string" },
        identity: IDENTITY_SCHEMA,
      },
      required: ["seq"],
    },
  },
  {
    name: "todo_write",
    description:
      "Replace this run's task list (durable, shown in the product UI). Pass the full desired list as items: [{id: string, text: string, status: pending | in_progress | done}]. The product injects your current list as Current Tasks in the system prompt.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "done"] },
            },
            required: ["id", "text", "status"],
          },
        },
        identity: IDENTITY_SCHEMA,
      },
      required: ["items"],
    },
  },
  {
    name: "ask_question",
    description:
      "Ask the user structured questions and wait for answers. Each question needs a string id and question text, a kind of select (with options) or text (free input). Returns {answers:[{id,selectedValues,freeText}]}. Blocks until the user answers in the product UI.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique id for this question" },
              question: { type: "string", description: "The question text" },
              kind: { type: "string", enum: ["select", "text"] },
              options: {
                type: "array",
                description: "Required when kind=select",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "Option text shown to the user" },
                    value: {
                      type: "string",
                      description: "Returned in selectedValues; defaults to label",
                    },
                    description: { type: "string" },
                  },
                  required: ["label"],
                },
              },
              allowOther: {
                type: "boolean",
                description: "Offer an extra free-text row of the user's own",
              },
            },
            required: ["id", "question"],
          },
        },
        identity: IDENTITY_SCHEMA,
      },
      required: ["questions"],
    },
  },
  {
    name: "artifact_upload",
    description:
      "Upload a single artifact file into backend artifact storage. Returns an artifacts://<folder>/<filename> URL.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string" },
        filename: { type: "string" },
        content: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"] },
        identity: IDENTITY_SCHEMA,
      },
      required: ["folder", "filename", "content"],
    },
  },
  {
    name: "artifact_download",
    description: "Download an artifact file by its artifacts://<folder>/<filename> URL.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        identity: IDENTITY_SCHEMA,
      },
      required: ["url"],
    },
  },
  {
    name: "remind_me",
    description:
      "Schedule a one-shot reminder in this conversation. At fireAt (epoch ms, must be future) the product posts the text here and a run voices it. Use for \"remind me in 30 minutes / tomorrow 9am\" style requests and for your own periodic maintenance nudges.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What the reminder says" },
        fireAt: { type: "number", description: "Epoch ms when it fires (future)" },
      },
      required: ["text", "fireAt"],
    },
  },
];

export function createProductToolsDispatch(deps: {
  readonly service: ProductToolsService;
}): ProductToolsDispatch {
  const { service } = deps;
  return {
    listTools: () => ({ tools: PRODUCT_TOOLS }),
    call: async (req) => {
      const { caller, name } = req;
      const args = req.args;
      const str = (v: unknown): string => (typeof v === "string" ? v : "");
      const meta = req.metaIdentity ? { identity: req.metaIdentity } : undefined;
      const argIdentity = (args.identity ?? {}) as Record<string, unknown>;
      const runId = caller.runId;
      const agentId = caller.agentId;
      // THE RUN COMES FROM THE RAIL'S AUTHENTICATED CALLER, NEVER FROM THE
      // ARGUMENTS.
      //
      // Every production MCP client here calls `callTool(name, args)` with no
      // `_meta` (only a fixture ever described that shape), so the `identity`
      // argument is text the model copied out of its prompt — and it does not
      // always copy it right. The old rule ("the args must match the
      // authenticated run") turned one stale echo into a hard rejection of a
      // legitimate call: observed live as "弹窗工具连续两次报 identity 不匹配",
      // after which the model gave up and asked in plain text, i.e. product
      // features failed for a reason the user could not see or fix. The run
      // token registry already names the run (mint-at-dispatch,
      // revoke-at-settle); that is the authority, and arguments cannot forge
      // it.
      //
      // `_meta` is the child's own wire identity, so a mismatch THERE means a
      // crossed/mis-wired process and still rejects.
      if (meta?.identity && str(meta.identity.runId) && str(meta.identity.runId) !== runId) {
        return {
          content: "identity does not match the session's authenticated run",
          isError: true,
        };
      }
      // callId stays the caller's when present (it is the model's tool-use id,
      // which is what makes retries replay); the idempotency key is BUILT HERE
      // from the authoritative run so a stale echo cannot break the service's
      // `${runId}:${callId}` invariant.
      const callId = str(meta?.identity?.callId) || str(argIdentity.callId) || randomUUID();
      const idempotencyKey = pendingActionId(runId, callId);
      try {
        return await service.call({
          identity: {
            runId,
            agentId,
            // Only the child's wire identity can carry scope; the model's echo
            // is not an authorization input (the service derives the scope from
            // the run row and treats an absent field as "unstated").
            conversationId: str(meta?.identity?.conversationId),
            branchId: str(meta?.identity?.branchId),
          },
          callId,
          idempotencyKey,
          tool: name,
          args,
        });
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  };
}
