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

/** ADR 0052 handback framing. The reason is the evidence, the optional
 *  suggestion is routing advice — the dispatcher decides what happens next. */
export function frameHandbackInput(
  fromAgentId: string,
  reason: string,
  suggestion?: string,
): string {
  const lines = [`（${fromAgentId} 把派给它的活退回来了）`, reason];
  if (suggestion) lines.push("", `建议：${suggestion}`);
  lines.push("", "这件活仍然由你负责：换人或自己做，不要当作已完成。");
  return lines.join("\n");
}

/** ADR 0059 D5: a dispatched worker reached a terminal state. Compact on
 *  purpose — who finished, how, and enough text for the dispatcher to write
 *  the human one sentence of its own (never a forward, never a transcript). */
export function frameResultInput(workerAgentId: string, status: string, text: string): string {
  const head =
    status === "completed"
      ? `（${workerAgentId} 完成了你派给它的活）`
      : `（${workerAgentId} 的活没有做成：${status}）`;
  // A notification, not a forward: the dispatcher writes its own sentence, so
  // a runaway transcript must not ride along. 2000 chars is far beyond "one
  // paragraph" and far below "the whole answer".
  const raw = text.trim();
  const body =
    raw === "" ? "（没有产出文字结果）" : raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw;
  return [
    head,
    verificationLine(undefined),
    body,
    "",
    "这是你派出去的工作的结果：向人交代，或继续处理。没有验收证据时不得说『已完成』。",
  ].join("\n");
}

/** ADR 0059 D6 report: the worker's own words, framed by purpose. `progress`
 *  never wakes the dispatcher (it lands in the ledger); `attention` and
 *  `answer` do. */
export type VerificationVerdict = "not_configured" | "not_run" | "passed" | "failed";

/** The verdict as a FIXED line. The dispatcher must not phrase the completion
 *  state itself: the state comes from the worker's recorded check, the
 *  dispatcher only explains it (ADR 0060 D1). */
export function verificationLine(verdict: VerificationVerdict | undefined): string {
  switch (verdict) {
    case "passed":
      return "验收：指定检查已通过";
    case "failed":
      return "验收：检查未通过";
    case "not_run":
      return "验收：检查已配置但没有执行";
    case "not_configured":
      return "验收：没有配置任何检查";
    default:
      return "验收：未提供验收证据（工人没有上报检查）";
  }
}

export function frameReportInput(
  workerAgentId: string,
  purpose: "progress" | "attention" | "answer",
  text: string,
  verdict?: VerificationVerdict,
): string {
  const head =
    purpose === "attention"
      ? `（${workerAgentId} 需要你的判断）`
      : purpose === "answer"
        ? `（${workerAgentId} 给你一个回答）`
        : `（${workerAgentId} 的进度）`;
  const lines = [head, verificationLine(verdict), text.trim()];
  if (verdict !== "passed") {
    // The rule travels with the data, not only in a prompt: the dispatcher
    // reads this line, so it cannot drift into "已完成" by accident.
    lines.push("", "据此措辞：不得说『已完成』，只能说执行结束与产物位置。");
  }
  return lines.join("\n");
}

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
    name: "dispatch",
    description:
      "Hand a task to another agent member of this conversation. Omit agent to let the worker pool pick: it prefers an idle worker and narrows by capability. The target joins the room if needed; your dispatch lands in the shared ledger and its run reports back here — the response names who took it. instruction must carry the requester's ORIGINAL words, never a paraphrase or an implementation plan; note (max ~30 words) is routing background only.",
    inputSchema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: "Target agent id. Omit it to use the pool.",
        },
        capability: {
          type: "string",
          description:
            "With agent omitted: what the work needs (e.g. react, backend). Matched against worker capability cards.",
        },
        verb: {
          type: "string",
          enum: ["fix", "build", "review", "investigate", "write", "operate", "answer"],
          description: "What the work DOES.",
        },
        deliverable: {
          type: "string",
          enum: ["answer", "change", "report", "state-change"],
          description: "What the human gets back.",
        },
        object: { type: "string", description: "What the work acts on, in the requester's words." },
        objectKind: { type: "string", enum: ["code", "doc", "service", "data", "other"] },
        references: {
          type: "array",
          items: { type: "string" },
          description: "Ledger/memory references you resolved for this task (e.g. seq:412, #123).",
        },
        reversibility: {
          type: "string",
          enum: ["reversible", "irreversible"],
          description: "Required for operate; irreversible needs the human's authority this turn.",
        },
        slots: {
          type: "object",
          description:
            "Executable details by verb (fix: repro/expected/scope/acceptance; review: target/criteria; operate: environment/action/rollback; ...). Missing slots are rejected — ask the human for all at once.",
        },
        instruction: { type: "string", description: "The task, in the requester's words" },
        note: { type: "string", description: "Optional routing background, at most ~30 words" },
        identity: IDENTITY_SCHEMA,
      },
      required: ["instruction", "verb", "deliverable"],
    },
  },
  {
    name: "handback",
    description:
      "Return a task that was dispatched to you when it is not yours to do — wrong skill, missing access, or a request that belongs to someone else. Wakes the agent that dispatched it, with your reason, in the same room. Use it instead of attempting work outside your capability or silently doing nothing. Only available when you were dispatched.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why this is not yours to do" },
        suggestion: { type: "string", description: "Optional: who could take it instead" },
        identity: IDENTITY_SCHEMA,
      },
      required: ["reason"],
    },
  },
  {
    name: "remember",
    description:
      "Write ONE durable lesson into your own long-term memory (ADR 0065). Use it only when the human explicitly asks you to remember something ('记住…', 'remember that…') — never to accumulate notes on your own. The line is appended to .oma/memory/learned.md in the format the memory pipeline reads; duplicates are ignored. Only a run the human started may call this.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The fact to remember, self-contained and in one or two sentences",
        },
        identity: IDENTITY_SCHEMA,
      },
      required: ["text"],
    },
  },
  {
    name: "steer_worker",
    description:
      "Redirect a worker that is ALREADY running in this conversation (the human changed their mind, or you see it heading the wrong way). The message reaches the worker mid-turn; it keeps its context and continues. This is not dispatch: a worker with no running task must get a new task via dispatch. Fails explicitly when nothing is running.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "The running worker's agent id" },
        message: {
          type: "string",
          description: "What changed, in the human's words — the worker keeps its context",
        },
        identity: IDENTITY_SCHEMA,
      },
      required: ["agent", "message"],
    },
  },
  {
    name: "cancel_worker",
    description:
      "Stop a worker that is already running in this conversation (runaway cost, wrong direction, the human said stop). The run settles as aborted and its dispatcher is notified. reason is required: an unexplained stop is worse than a bad attempt. Fails explicitly when nothing is running.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "The running worker's agent id" },
        reason: { type: "string", description: "Why this work must stop — recorded for audit" },
        identity: IDENTITY_SCHEMA,
      },
      required: ["agent", "reason"],
    },
  },
  {
    name: "report",
    description:
      "Talk upward to whoever dispatched this run (ADR 0059). purpose=progress is a ledger note that does NOT wake them — use it for plain progress; purpose=attention wakes them now (a decision you cannot make, a blocker); purpose=answer hands back a direct answer. Keep text compact and factual: the dispatcher rewrites it for the human. Only available when you were dispatched.",
    inputSchema: {
      type: "object",
      properties: {
        purpose: {
          type: "string",
          enum: ["progress", "attention", "answer"],
          description:
            "progress: ledger only, no wake. attention: wake the dispatcher now. answer: a direct answer for them.",
        },
        text: { type: "string", description: "What they should know, compactly" },
        verification: {
          type: "string",
          enum: ["not_configured", "not_run", "passed", "failed"],
          description:
            "验收证据（ADR 0060）：not_configured=没有配置检查；not_run=配了没跑；passed/failed=执行结果。不传=没有证据，不得暗示通过。",
        },
        identity: IDENTITY_SCHEMA,
      },
      required: ["purpose", "text"],
    },
  },
  {
    name: "wiki_read",
    description:
      "Read one wiki page (frontmatter + body + revision). Paths are root-relative: projects/<p>/x.md, decisions/x.md, concepts/x.md, lessons/x.md, personal/<your agentId>/x.md.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, identity: IDENTITY_SCHEMA },
      required: ["path"],
    },
  },
  {
    name: "wiki_query",
    description:
      "Search the wiki (title + body substring). Use it before answering from memory: compiled knowledge beats re-deriving. Returns path, title, status, maintainedBy, snippet.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        limit: { type: "number" },
        identity: IDENTITY_SCHEMA,
      },
    },
  },
  {
    name: "wiki_create",
    description:
      "Create a NEW wiki page. Needs path, title and content. Always cite sources (conversation:<id>:<from>-<to>, file:raw/files/<name>, or a URL) — an unsourced page is a rumour and lint will say so. Pages under personal/ belong to you alone.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        status: { type: "string", enum: ["draft", "confirmed", "superseded"] },
        sources: { type: "array", items: { type: "string" } },
        supersedes: { type: "array", items: { type: "string" } },
        identity: IDENTITY_SCHEMA,
      },
      required: ["path", "title", "content"],
    },
  },
  {
    name: "wiki_patch",
    description:
      "Update an EXISTING page. Read it first and pass the revision you read as expected_revision — a stale revision is refused (someone else changed it; re-read and merge). content replaces the whole body.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        expected_revision: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        status: { type: "string", enum: ["draft", "confirmed", "superseded"] },
        sources: { type: "array", items: { type: "string" } },
        supersedes: { type: "array", items: { type: "string" } },
        identity: IDENTITY_SCHEMA,
      },
      required: ["path", "expected_revision"],
    },
  },
  {
    name: "wiki_lint",
    description:
      "Health-check the wiki: unsourced pages, orphan pages (nothing links to them), supersedes targets that do not exist. Report findings; do not silently rewrite pages to fix them.",
    inputSchema: { type: "object", properties: { identity: IDENTITY_SCHEMA } },
  },
  {
    name: "wiki_source_add",
    description:
      "Save RAW material. kind=conversation records a ledger RANGE by reference (the chat is never copied); kind=text saves material verbatim under raw/files/. Saving is not endorsing — compile claims into pages separately.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["conversation", "text"] },
        conversation_id: { type: "string" },
        from_seq: { type: "number" },
        to_seq: { type: "number" },
        title: { type: "string" },
        content: { type: "string" },
        identity: IDENTITY_SCHEMA,
      },
      required: ["kind"],
    },
  },
  {
    name: "project_list",
    description:
      "List the registered projects (id, name, repo). Use it to decide WHICH project a request is about before filing a requirement or dispatching; if two projects fit, ask.",
    inputSchema: { type: "object", properties: { identity: IDENTITY_SCHEMA } },
  },
  {
    name: "requirement_track",
    description:
      "Create or update a tracked work item (requirement) for a goal worth following: multiple turns, dispatch to team members, delivery and acceptance. NOT for one-shot Q&A. Create needs title and goal; update needs requirement_id and only the fields you change. The user's own words stay in the conversation - your summary goes here, and they can correct it.",
    inputSchema: {
      type: "object",
      properties: {
        requirement_id: { type: "string", description: "Omit to create" },
        project: { type: "string", description: "Project id or name this goal belongs to" },
        title: { type: "string" },
        goal: { type: "string", description: "What done looks like" },
        background: { type: "string" },
        constraints: { type: "string" },
        expected_deliverables: { type: "string" },
        acceptance_criteria: { type: "string" },
        identity: IDENTITY_SCHEMA,
      },
      required: ["title", "goal"],
    },
  },
  {
    name: "requirement_query",
    description:
      "Read tracked work items: one by id (with its runs, verification and open requests), or the list with include_closed. Use it to resume work in a new conversation - status comes from execution records, not from anyone's summary.",
    inputSchema: {
      type: "object",
      properties: {
        requirement_id: { type: "string" },
        include_closed: { type: "boolean" },
        identity: IDENTITY_SCHEMA,
      },
    },
  },
  {
    name: "team_list",
    description:
      "List the team's agents with their capability cards: id, name, description, skills. Read before dispatching to decide who takes a task.",
    inputSchema: { type: "object", properties: {}, required: [] },
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
      'Schedule a one-shot reminder in this conversation. At fireAt (epoch ms, must be future) the product posts the text here and a run voices it. Use for "remind me in 30 minutes / tomorrow 9am" style requests and for your own periodic maintenance nudges.',
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What the reminder says" },
        fireAt: { type: "number", description: "Epoch ms when it fires (future)" },
        recurrence: {
          type: "string",
          description:
            "Optional 5-field cron expression for recurring wake-ups (e.g. '0 9 * * *' = daily 9am); omit for one-shot",
        },
      },
      required: ["text", "fireAt"],
    },
  },
  {
    name: "reminder_list",
    description:
      "List your own pending reminders (one-shot and recurring) with their ids, schedules and texts.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "reminder_cancel",
    description: "Cancel one of your pending reminders by id (from reminder_list).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The reminder id" } },
      required: ["id"],
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
