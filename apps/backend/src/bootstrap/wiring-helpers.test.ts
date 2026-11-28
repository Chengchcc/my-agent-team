import { describe, expect, test } from "bun:test";
import type { Message } from "@chengchenccc/message";
import type { WikiService } from "../features/wiki/index.js";
import { openDb } from "../infra/sqlite/db.js";
import {
  createRoleOfAgent,
  observeCommittedTurn,
  readDispatcherPlan,
  readRunArtifactUrls,
  surfaceParkedRequest,
} from "./wiring-agent-run.js";
import {
  buildRosterCards,
  rememberLesson,
  resolveDispatchProject,
} from "./wiring-product-tools.js";

function seedAgent(db: ReturnType<typeof openDb>, id: string, config: unknown): void {
  const now = Date.now();
  db.query(
    `INSERT INTO agents (id, workspace_path, config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, `/tmp/${id}`, JSON.stringify(config), now, now);
}

function seedRun(
  db: ReturnType<typeof openDb>,
  opts: {
    runId: string;
    conversationId: string;
    branchId: string;
    agentId: string;
    todoSnapshot?: string | null;
  },
): void {
  const now = Date.now();
  db.query(
    `INSERT OR IGNORE INTO conversation (conversation_id, agent_id, created_at)
     VALUES (?, ?, ?)`,
  ).run(opts.conversationId, opts.agentId, now);
  db.query(
    `INSERT OR IGNORE INTO agent_context_tree (tree_id, conversation_id, agent_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(`tree-${opts.branchId}`, opts.conversationId, opts.agentId, now);
  db.query(
    `INSERT OR IGNORE INTO agent_context_branch (branch_id, tree_id, backend_kind, is_default, revision, created_at)
     VALUES (?, ?, 'acp', 1, 1, ?)`,
  ).run(opts.branchId, `tree-${opts.branchId}`, now);
  db.query(
    `INSERT INTO agent_run (
       run_id, conversation_id, agent_id, branch_id, model_ref, status,
       idempotency_key, config_revision, todo_snapshot, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.runId,
    opts.conversationId,
    opts.agentId,
    opts.branchId,
    "acp:oma",
    "completed",
    `idem-${opts.runId}`,
    1,
    opts.todoSnapshot ?? null,
    now,
  );
}

describe("createRoleOfAgent", () => {
  test("returns worker, front (default), and null for missing/malformed rows", () => {
    const db = openDb(":memory:");
    try {
      const roleOf = createRoleOfAgent(db);
      expect(roleOf("missing")).toBeNull();

      seedAgent(db, "coder", { role: "worker" });
      seedAgent(db, "pa", { role: "front" });
      seedAgent(db, "legacy", {});
      db.query(
        `INSERT INTO agents (id, workspace_path, config, created_at, updated_at)
         VALUES ('broken', '/tmp/broken', '{not-json', 1, 1)`,
      ).run();

      expect(roleOf("coder")).toBe("worker");
      expect(roleOf("pa")).toBe("front");
      expect(roleOf("legacy")).toBe("front");
      expect(roleOf("broken")).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("readDispatcherPlan & readRunArtifactUrls", () => {
  test("reads latest non-empty todo_snapshot and skips malformed entries", () => {
    const db = openDb(":memory:");
    try {
      seedRun(db, {
        runId: "run-1",
        conversationId: "conv-1",
        branchId: "br-1",
        agentId: "pa",
        todoSnapshot: JSON.stringify([
          { text: "Draft spec", status: "done" },
          { text: "Implement", status: "" },
          { text: "" },
          null,
        ]),
      });
      seedRun(db, {
        runId: "run-2",
        conversationId: "conv-2",
        branchId: "br-2",
        agentId: "pa",
        todoSnapshot: "{bad-json",
      });

      expect(readDispatcherPlan(db, null)).toBe("");
      expect(readDispatcherPlan(db, "conv-none")).toBe("");
      expect(readDispatcherPlan(db, "conv-2")).toBe("");
      expect(readDispatcherPlan(db, "conv-1")).toBe("- [done] Draft spec\n- [pending] Implement");
    } finally {
      db.close();
    }
  });

  test("extracts only artifacts:// URLs from artifact_upload calls", () => {
    const db = openDb(":memory:");
    try {
      seedRun(db, {
        runId: "run-1",
        conversationId: "conv-1",
        branchId: "br-1",
        agentId: "coder",
      });
      const insert = db.query(
        `INSERT INTO product_tool_call (
           run_id, call_id, tool_name, input_hash, status, result, created_at
         ) VALUES (?, ?, ?, ?, 'completed', ?, ?)`,
      );
      insert.run(
        "run-1",
        "c1",
        "artifact_upload",
        "h1",
        JSON.stringify({ url: "artifacts://reports/a.md" }),
        1,
      );
      insert.run(
        "run-1",
        "c2",
        "artifact_upload",
        "h2",
        JSON.stringify({ url: "https://example.com/nope" }),
        2,
      );
      insert.run("run-1", "c3", "artifact_upload", "h3", "{bad", 3);
      insert.run(
        "run-1",
        "c4",
        "dispatch",
        "h4",
        JSON.stringify({ url: "artifacts://reports/ignored.md" }),
        4,
      );

      expect(readRunArtifactUrls(db, "run-1")).toEqual(["artifacts://reports/a.md"]);
      expect(readRunArtifactUrls(db, "run-empty")).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("observeCommittedTurn", () => {
  test("records unasked_question, irreversible_unasked, and unrouted_work for front desk", async () => {
    const db = openDb(":memory:");
    try {
      const events: Array<{ runId: string; kind: string; payload: Record<string, unknown> }> = [];
      const longAnswer = `${"详细分析内容。".repeat(150)}\n\n要不要我继续修改？`;

      await observeCommittedTurn(
        {
          db,
          agentSvc: {
            getById: async () => ({ config: { role: "front" } }) as never,
          },
          agentRunPort: {
            listPendingActions: async () => [],
            listDecidedActions: async () => [],
          },
          agentRunService: {
            listInputs: async () =>
              [
                {
                  runId: "run-fd-1",
                  message: { role: "user", text: "直接帮我清空所有工作区并删除全部数据" },
                },
              ] as never,
          },
          opsStore: {
            appendRunEvent: (runId, kind, payload) => {
              events.push({ runId, kind, payload });
            },
          },
        },
        {
          runId: "run-fd-1",
          agentId: "pa",
          branchId: "br-1",
          output: { role: "assistant", text: longAnswer } as Message,
        },
      );

      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain("unasked_question");
      expect(kinds).toContain("irreversible_unasked");
      expect(kinds).toContain("unrouted_work");
    } finally {
      db.close();
    }
  });

  test("records status_question_dispatched and suppresses unrouted_work when dispatch occurred", async () => {
    const db = openDb(":memory:");
    try {
      seedRun(db, {
        runId: "run-fd-2",
        conversationId: "conv-1",
        branchId: "br-2",
        agentId: "pa",
      });
      db.query(
        `INSERT INTO product_tool_call (
           run_id, call_id, tool_name, input_hash, status, result, created_at
         ) VALUES ('run-fd-2', 'c1', 'dispatch', 'h1', 'completed', '{}', 1)`,
      ).run();

      const events: Array<{ kind: string }> = [];
      await observeCommittedTurn(
        {
          db,
          agentSvc: {
            getById: async () => ({ config: { role: "front" } }) as never,
          },
          agentRunPort: {
            listPendingActions: async () => [{ kind: "ask" }] as never,
            listDecidedActions: async () => [],
          },
          agentRunService: {
            listInputs: async () =>
              [
                {
                  runId: "run-fd-2",
                  message: { role: "user", text: "目前进展怎么样？" },
                },
              ] as never,
          },
          opsStore: {
            appendRunEvent: (_runId, kind) => {
              events.push({ kind });
            },
          },
        },
        {
          runId: "run-fd-2",
          agentId: "pa",
          branchId: "br-2",
          output: { role: "assistant", text: `${"a".repeat(900)}？` } as Message,
        },
      );

      expect(events.map((e) => e.kind)).toEqual(["status_question_dispatched"]);
    } finally {
      db.close();
    }
  });

  test("skips front-desk-only observations for worker role", async () => {
    const db = openDb(":memory:");
    try {
      const events: Array<{ kind: string }> = [];
      await observeCommittedTurn(
        {
          db,
          agentSvc: {
            getById: async () => ({ config: { role: "worker" } }) as never,
          },
          agentRunPort: {
            listPendingActions: async () => [],
            listDecidedActions: async () => [],
          },
          agentRunService: {
            listInputs: async () =>
              [{ runId: "run-w-1", message: { role: "user", text: "删除生产库" } }] as never,
          },
          opsStore: {
            appendRunEvent: (_runId, kind) => {
              events.push({ kind });
            },
          },
        },
        {
          runId: "run-w-1",
          agentId: "coder",
          branchId: "br-w",
          output: { role: "assistant", text: "x".repeat(1000) } as Message,
        },
      );

      expect(events).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("surfaceParkedRequest (ADR 0075)", () => {
  test("wakes parent room front desk when a child room parks on a human-owned decision", async () => {
    const posted: Array<{ conversationId: string; content: unknown }> = [];
    await surfaceParkedRequest(
      {
        agentSvc: {
          getById: async () => ({ config: { name: "Coder" } }) as never,
        } as never,
        agentRunPort: {
          getRun: async () =>
            ({
              runId: "run-child",
              conversationId: "conv-child",
              agentId: "coder",
              authorization: "user",
            }) as never,
        } as never,
        convPort: {
          getConversation: (id: string) =>
            id === "conv-child"
              ? ({
                  conversationId: "conv-child",
                  parentConversationId: "conv-parent",
                  title: "Fix Auth",
                  agentId: "coder",
                } as never)
              : ({
                  conversationId: "conv-parent",
                  parentConversationId: null,
                  agentId: "pa",
                } as never),
        } as never,
        convSvc: {
          postMessage: async (msg: { conversationId: string; content: unknown }) => {
            posted.push(msg);
            return { triggeredRuns: [] } as never;
          },
        } as never,
        roleOfAgent: () => "worker",
      },
      {
        runId: "run-child",
        callId: "call-1",
        kind: "approval",
        payload: { toolName: "bash", reason: "git push --force" },
      },
    );

    expect(posted).toHaveLength(1);
    expect(posted[0]?.conversationId).toBe("conv-parent");
    expect(String(posted[0]?.content)).toContain("【需要人类决定】");
    expect(String(posted[0]?.content)).toContain("git push --force");
  });

  test("routes worker-dispatched request to dispatcher with answer_worker_request hint", async () => {
    const posted: Array<{ conversationId: string; content: unknown }> = [];
    await surfaceParkedRequest(
      {
        agentSvc: {
          getById: async () => ({ config: { name: "Researcher" } }) as never,
        } as never,
        agentRunPort: {
          getRun: async () =>
            ({
              runId: "run-sub",
              conversationId: "conv-sub",
              agentId: "researcher",
              authorization: "dispatch:pa",
            }) as never,
        } as never,
        convPort: {
          getConversation: () =>
            ({
              conversationId: "conv-sub",
              parentConversationId: "conv-parent",
              agentId: "researcher",
            }) as never,
        } as never,
        convSvc: {
          postMessage: async (msg: { conversationId: string; content: unknown }) => {
            posted.push(msg);
            return { triggeredRuns: [] } as never;
          },
        } as never,
        roleOfAgent: (id) => (id === "pa" ? "front" : "worker"),
      },
      {
        runId: "run-sub",
        callId: "ask-9",
        kind: "ask",
        payload: { questions: [{ question: "Which target branch?" }] },
      },
    );

    expect(posted).toHaveLength(1);
    expect(posted[0]?.conversationId).toBe("conv-parent");
    expect(String(posted[0]?.content)).toContain(
      'answer_worker_request(run_id="run-sub", call_id="ask-9"',
    );
  });
});

describe("rememberLesson (C2-A personal Wiki memory)", () => {
  test("rejects blank lessons, creates on first write, deduplicates across dates, and retries CAS conflicts", async () => {
    const pages = new Map<string, { body: string; revision: string }>();
    let conflictsRemaining = 1;

    const wiki: Pick<WikiService, "read" | "create" | "patch"> = {
      read: (path: string) => {
        const p = pages.get(path);
        return p ? ({ path, body: p.body, revision: p.revision } as never) : null;
      },
      create: async (input) => {
        pages.set(input.path, { body: input.content ?? "", revision: "rev-1" });
        return { ok: true as const, page: { path: input.path } as never, findings: [] };
      },
      patch: async (input) => {
        if (conflictsRemaining > 0) {
          conflictsRemaining--;
          return { ok: false as const, reason: "conflict" as const, current: null };
        }
        pages.set(input.path, { body: input.content ?? "", revision: "rev-2" });
        return { ok: true as const, page: { path: input.path } as never, findings: [] };
      },
    };

    expect(
      await rememberLesson(wiki, { agentId: "pa", conversationId: "c1", text: "   \n\t  " }),
    ).toEqual({ saved: false, reason: "empty lesson" });

    expect(
      await rememberLesson(wiki, {
        agentId: "pa",
        conversationId: "c1",
        text: "  Always   use Bun  ",
        todayIso: "2026-11-27",
      }),
    ).toEqual({ saved: true });
    expect(pages.get("personal/pa/memories.md")?.body).toBe("- [2026-11-27] Always use Bun");

    // Same lesson on a later date is deduplicated.
    expect(
      await rememberLesson(wiki, {
        agentId: "pa",
        conversationId: "c2",
        text: "Always use Bun",
        todayIso: "2026-11-28",
      }),
    ).toEqual({ saved: true, reason: "already remembered" });

    // Second distinct lesson hits 1 CAS conflict then succeeds on retry.
    expect(
      await rememberLesson(wiki, {
        agentId: "pa",
        conversationId: "c2",
        text: "Never force push main",
        todayIso: "2026-11-28",
      }),
    ).toEqual({ saved: true });
    expect(conflictsRemaining).toBe(0);
    expect(pages.get("personal/pa/memories.md")?.body).toBe(
      "- [2026-11-27] Always use Bun\n- [2026-11-28] Never force push main",
    );
  });

  test("returns concurrent update conflict when all 3 CAS retries fail", async () => {
    const wiki: Pick<WikiService, "read" | "create" | "patch"> = {
      read: () => ({ body: "- [2026-11-27] Existing", revision: "rev-1" }) as never,
      create: async () => ({ ok: false as const, reason: "conflict" as const, current: null }),
      patch: async () => ({ ok: false as const, reason: "conflict" as const, current: null }),
    };
    const res = await rememberLesson(wiki, {
      agentId: "pa",
      conversationId: "c1",
      text: "New rule",
    });
    expect(res).toEqual({ saved: false, reason: "concurrent update conflict" });
  });
});

describe("resolveDispatchProject & buildRosterCards", () => {
  const p1 = { projectId: "p1", name: "crewdesk" };
  const p2 = { projectId: "p2", name: "billing" };
  const projects: Record<string, { projectId: string; name: string }> = { p1, p2 };

  test("room project wins when worker is attached; falls back to brief/instruction match", () => {
    expect(
      resolveDispatchProject({
        attached: ["p1", "p2"],
        roomProjectId: "p1",
        getProject: (id) => projects[id]!,
        briefObject: "billing invoice",
        instruction: "fix billing",
      }),
    ).toEqual(p1);

    // Room project not attached to worker -> fall back to attached match in brief.
    expect(
      resolveDispatchProject({
        attached: ["p2"],
        roomProjectId: "p1",
        getProject: (id) => projects[id]!,
        briefObject: "billing invoice",
        instruction: "fix it",
      }),
    ).toEqual(p2);

    // Neither room nor text matches any attached project -> null.
    expect(
      resolveDispatchProject({
        attached: ["p2"],
        roomProjectId: null,
        getProject: (id) => projects[id]!,
        briefObject: "docs",
        instruction: "summarize",
      }),
    ).toBeNull();
  });

  test("buildRosterCards filters archived/disabled agents and resolves project names", async () => {
    const cards = await buildRosterCards(
      {
        list: async () =>
          [
            {
              id: "coder",
              archivedAt: null,
              config: {
                enabled: true,
                name: "Coder",
                description: "Writes code",
                skills: [
                  { id: "ts", description: "TypeScript" },
                  { id: "git", description: "" },
                ],
                runtime_config: { projects: ["p1"] },
              },
            },
            {
              id: "disabled",
              archivedAt: null,
              config: {
                enabled: false,
                name: "Disabled",
                description: "",
                skills: [],
                runtime_config: { projects: [] },
              },
            },
            {
              id: "archived",
              archivedAt: 123,
              config: {
                enabled: true,
                name: "Archived",
                description: "",
                skills: [],
                runtime_config: { projects: [] },
              },
            },
          ] as never,
      },
      { getById: (id) => projects[id] as never },
    );

    expect(cards).toEqual([
      {
        id: "coder",
        name: "Coder",
        description: "Writes code",
        skills: ["ts：TypeScript", "git"],
        projects: [{ projectId: "p1", name: "crewdesk" }],
      },
    ]);
  });
});
