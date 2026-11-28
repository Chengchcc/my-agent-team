import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowDefinition } from "@chengchenccc/workflow";
import { Elysia } from "elysia";
import { HttpError } from "../../infra/errors.js";
import { openDb } from "../../infra/sqlite/db.js";
import { applyProposal } from "../proposal/apply.js";
import { createRequirementService, sqliteRequirementAdapter } from "../requirement/index.js";
import { sqliteWorkflowExecutionAdapter } from "./adapter-sqlite.js";
import { workflowRoutes } from "./http.js";
import { createWorkflowExecutionService, type WorkflowLifecycleNotification } from "./service.js";
import { createFsWorkflowStore } from "./store.js";
import { createWorkflowTriggerScheduler } from "./trigger-scheduler.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "adr0084-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeDb(): Database {
  const dir = makeTmpDir();
  return openDb(join(dir, "test.db"));
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

let idSeq = 0;
const nextId = () => `id-${++idSeq}`;

const declarativeSop: WorkflowDefinition = {
  version: 1,
  id: "release-sop",
  meta: { name: "Release SOP", status: "active" },
  nodes: [
    { id: "start", type: "start" },
    { id: "review", type: "agent", capability: "code-review", prompt: "Review PR" },
    { id: "done", type: "end", status: "success" },
  ],
  edges: [
    { from: "start", to: "review" },
    { from: "review", to: "done" },
  ],
};

describe("ADR 0084: Workflow HTTP validation, script testing & git history/revert", () => {
  test("POST /validate checks schema, semantics, risk, and scriptNodesBlocked", async () => {
    const dir = makeTmpDir();
    const store = createFsWorkflowStore(dir);
    const db = makeDb();
    db.query(
      "INSERT INTO project (project_id, name, repo_url, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("proj-1", "Project 1", "https://example.com/p1.git", "main", Date.now(), Date.now());
    db.query("INSERT INTO conversation (conversation_id, title, created_at) VALUES (?, ?, ?)").run(
      "room-pa",
      "PA Room",
      Date.now(),
    );
    const port = sqliteWorkflowExecutionAdapter(db);
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {} as never,
      idGen: nextId,
    });

    const app = new Elysia()
      .onError(({ error, set }) => {
        if (error instanceof HttpError) {
          set.status = error.status;
          return { error: error.message };
        }
        set.status = 500;
        return { error: String(error) };
      })
      .use(
        workflowRoutes({
          workflowExecutionService: svc,
          loadWorkflow: async () => "{}",
          workflowDir: dir,
          store,
          scriptsEnabled: false,
          validateSemantics: async (def) =>
            def.nodes
              .filter((n) => n.type === "agent" && n.agentId === "missing-agent")
              .map((n) => `node "${n.id}": agent "missing-agent" does not exist`),
          testScript: async ({ code, input }) => ({
            ok: true,
            exitCode: 0,
            output: { echoed: input, len: code.length },
            stdout: "",
            stderr: "",
            durationMs: 1,
          }),
        }),
      );

    // 1. Valid declarative SOP with a script node when scriptsEnabled=false
    const res = await app.handle(
      new Request("http://localhost/api/workflow-definitions/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowId: "wf-check",
          definition: {
            version: 1,
            id: "wf-check",
            nodes: [
              { id: "start", type: "start" },
              { id: "s1", type: "script", code: "export default () => ({ ok: true });" },
              { id: "done", type: "end", status: "success" },
            ],
            edges: [
              { from: "start", to: "s1" },
              { from: "s1", to: "done" },
            ],
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      valid: boolean;
      issues: string[];
      risk: { reasons: string[] };
      scriptNodesBlocked: boolean;
    };
    expect(body.valid).toBe(true);
    expect(body.issues).toEqual([]);
    expect(body.risk.reasons).toEqual(["script"]);
    expect(body.scriptNodesBlocked).toBe(true);

    // 2. Semantic error caught
    const semRes = await app.handle(
      new Request("http://localhost/api/workflow-definitions/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          definition: {
            version: 1,
            id: "wf-bad-agent",
            nodes: [
              { id: "start", type: "start" },
              { id: "a", type: "agent", agentId: "missing-agent" },
              { id: "done", type: "end", status: "success" },
            ],
            edges: [
              { from: "start", to: "a" },
              { from: "a", to: "done" },
            ],
          },
        }),
      }),
    );
    const semBody = (await semRes.json()) as { valid: boolean; issues: string[] };
    expect(semBody.valid).toBe(false);
    expect(semBody.issues[0]).toContain("missing-agent");

    // 3. /test-script rejects with 403 when scriptsEnabled=false
    const blockedRes = await app.handle(
      new Request("http://localhost/api/workflow-definitions/test-script", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "export default () => ({ ok: true });", input: { x: 1 } }),
      }),
    );
    expect(blockedRes.status).toBe(403);
    db.close();
  });

  test("PUT / history / revert and /test-script when enabled", async () => {
    const dir = makeTmpDir();
    const store = createFsWorkflowStore(dir);
    const db = makeDb();
    db.query(
      "INSERT INTO project (project_id, name, repo_url, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("proj-1", "Project 1", "https://example.com/p1.git", "main", Date.now(), Date.now());
    db.query("INSERT INTO conversation (conversation_id, title, created_at) VALUES (?, ?, ?)").run(
      "room-pa",
      "PA Room",
      Date.now(),
    );
    const port = sqliteWorkflowExecutionAdapter(db);
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {} as never,
      idGen: nextId,
    });

    const app = new Elysia().use(
      workflowRoutes({
        workflowExecutionService: svc,
        loadWorkflow: async () => "{}",
        workflowDir: dir,
        store,
        scriptsEnabled: true,
        testScript: async ({ code, input }) => ({
          ok: true,
          exitCode: 0,
          output: { input, lines: code.split("\n").length },
          stdout: "hello",
          stderr: "",
          durationMs: 3,
        }),
      }),
    );

    // /test-script runs when enabled
    const scriptRes = await app.handle(
      new Request("http://localhost/api/workflow-definitions/test-script", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "export default (i) => i;", input: { n: 42 } }),
      }),
    );
    expect(scriptRes.status).toBe(200);
    const scriptBody = (await scriptRes.json()) as {
      ok: boolean;
      output: { input: { n: number } };
      stdout: string;
    };
    expect(scriptBody.ok).toBe(true);
    expect(scriptBody.output.input.n).toBe(42);
    expect(scriptBody.stdout).toBe("hello");

    // PUT v1 then v2, check history, revert to v1
    const v1 = { ...declarativeSop, meta: { name: "SOP v1" } };
    const v2 = { ...declarativeSop, meta: { name: "SOP v2" } };
    const p1 = await app.handle(
      new Request("http://localhost/api/workflow-definitions/release-sop", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definition: v1 }),
      }),
    );
    expect(p1.status).toBe(200);
    const p2 = await app.handle(
      new Request("http://localhost/api/workflow-definitions/release-sop", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definition: v2 }),
      }),
    );
    expect(p2.status).toBe(200);

    const histRes = await app.handle(
      new Request("http://localhost/api/workflow-definitions/release-sop/history"),
    );
    const histBody = (await histRes.json()) as {
      gitReady: boolean;
      history: Array<{ commit: string; subject: string }>;
    };
    expect(histBody.gitReady).toBe(true);
    expect(histBody.history.length).toBeGreaterThanOrEqual(2);
    const v1Commit = histBody.history.at(-1)!.commit;

    const revRes = await app.handle(
      new Request("http://localhost/api/workflow-definitions/release-sop/revert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commit: v1Commit }),
      }),
    );
    expect(revRes.status).toBe(200);
    const revBody = (await revRes.json()) as {
      ok: boolean;
      definition: { meta: { name: string } };
    };
    expect(revBody.ok).toBe(true);
    expect(revBody.definition.meta.name).toBe("SOP v1");
    db.close();
  });
});

describe("ADR 0084: Proposal apply for workflow_definition envelopes", () => {
  test("adopting a wrapped workflow_definition proposal calls saveWorkflowDefinition with unwrapped definition", async () => {
    const saved: Array<{ id: string; def: unknown }> = [];
    await applyProposal({
      kind: "workflow_definition",
      targetId: "release-sop",
      payload: {
        definition: declarativeSop,
        requiresApprovalFor: ["script"],
        scriptNodes: [{ id: "s1", code: "export default () => ({});" }],
      },
      deps: {
        updateAgent: async () => {},
        createProject: async () => "p1",
        saveWorkflowDefinition: async (workflowId, def) => {
          saved.push({ id: workflowId, def });
        },
      },
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.id).toBe("release-sop");
    expect((saved[0]!.def as WorkflowDefinition).id).toBe("release-sop");
  });
});

describe("ADR 0084: Shared Requirement, capability routing, concurrency policy & notifications", () => {
  test("multi-node repo workflow creates ONE shared Requirement, routes by capability, and emits lifecycle callbacks", async () => {
    const db = makeDb();
    db.query(
      "INSERT INTO project (project_id, name, repo_url, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("proj-1", "Project 1", "https://example.com/p1.git", "main", Date.now(), Date.now());
    db.query("INSERT INTO conversation (conversation_id, title, created_at) VALUES (?, ?, ?)").run(
      "room-pa",
      "PA Room",
      Date.now(),
    );
    const port = sqliteWorkflowExecutionAdapter(db);
    const reqSvc = createRequirementService({
      port: sqliteRequirementAdapter(db),
      idGen: () => `req-shared-${reqCounter}`,
    });
    const attachedConvs: Array<{ conversationId: string; requirementId: string }> = [];
    const runReqs: Array<{ runId: string; requirementId: string }> = [];
    const notices: WorkflowLifecycleNotification[] = [];
    let reqCounter = 0;

    const multiNodeDef: WorkflowDefinition = {
      version: 1,
      id: "pr-pipeline",
      meta: { name: "PR Pipeline" },
      nodes: [
        { id: "start", type: "start" },
        {
          id: "code",
          type: "agent",
          capability: "backend-coder",
          repo: "proj-1",
          prompt: "Implement",
        },
        {
          id: "review",
          type: "agent",
          capability: "code-review",
          repo: "proj-1",
          prompt: "Review",
        },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "code" },
        { from: "code", to: "review" },
        { from: "review", to: "done" },
      ],
    };

    const routedAgents: string[] = [];
    let runIdx = 0;
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {} as never,
      idGen: nextId,
      agentRunService: {
        getRun: async () => ({
          status: "completed",
          terminalResult: {
            status: "completed",
            messages: [{ role: "assistant", text: '{"ok": true}' }],
          },
        }),
      } as never,
      agentRunExecution: {
        dispatch: async () => {},
        subscribe: async function* () {
          yield { type: "status", status: "completed" };
        },
      } as never,
      convPort: {
        getConversation: () => null,
        createConversation: (input: { agentId?: string }) => {
          if (input.agentId) routedAgents.push(input.agentId);
        },
      } as never,
      conversationService: {
        postMessage: async () => {
          runIdx += 1;
          return { triggeredRuns: [{ runId: `run-${runIdx}`, queued: true }] };
        },
      } as never,
      resolveDefaultModel: async () => ({ backendKind: "oma", modelId: "m1" }),
      agentProjects: async () => ["proj-1"],
      ensureRequirementForExecution: ({ workflowId, workflowName, projectId }) => {
        reqCounter += 1;
        return reqSvc.create({
          title: workflowName ?? workflowId,
          goal: `Shared requirement for ${workflowId}`,
          projectId,
          originConversationId: null,
          createdByAgentId: null,
        }).requirementId;
      },
      attachConversationRequirement: (entry) => attachedConvs.push(entry),
      setRunRequirement: (runId, requirementId) => runReqs.push({ runId, requirementId }),
      resolveCapabilityAgent: async ({ capability }) =>
        capability === "backend-coder" ? "coder-1" : "reviewer-1",
      onExecutionStateChange: (ev) => {
        notices.push(ev);
      },
    });

    const result = await svc.runToCompletion("exec-shared", {
      workflowId: "pr-pipeline",
      definition: multiNodeDef,
      input: {},
      conversationId: "room-pa",
      triggeredBy: "agent:pa",
    });

    expect(result.status).toBe("success");
    // Only ONE requirement was created and shared across both nodes!
    expect(reqCounter).toBe(1);
    expect(attachedConvs).toEqual([
      { conversationId: "workflow:exec-shared:code", requirementId: "req-shared-1" },
      { conversationId: "workflow:exec-shared:review", requirementId: "req-shared-1" },
    ]);
    expect(runReqs).toEqual([
      { runId: "run-1", requirementId: "req-shared-1" },
      { runId: "run-2", requirementId: "req-shared-1" },
    ]);
    // Capability routing selected distinct workers per node
    expect(routedAgents).toEqual(["coder-1", "reviewer-1"]);
    // Lifecycle callback fired on terminal completion
    expect(notices.some((n) => n.kind === "completed" && n.executionId === "exec-shared")).toBe(
      true,
    );
    db.close();
  });

  test("RequirementView includes workflowExecutions and derives waiting_for_user / in_progress", async () => {
    const db = makeDb();
    const reqPort = sqliteRequirementAdapter(db);
    const reqSvc = createRequirementService({ port: reqPort, idGen: () => "req-wf-1" });
    reqSvc.create({
      title: "Release v2",
      goal: "Ship release",
      projectId: null,
      originConversationId: null,
      createdByAgentId: null,
    });

    const wfPort = sqliteWorkflowExecutionAdapter(db);
    await wfPort.createExecution({
      executionId: "exec-1",
      workflowId: "release-sop",
      requirementId: "req-wf-1",
      definition: declarativeSop,
      input: {},
      store: {},
    });

    let view = reqSvc.get("req-wf-1");
    expect(view.workflowExecutions).toHaveLength(1);
    expect(view.derivedStatus).toBe("in_progress");

    await wfPort.updateExecution("exec-1", { status: "waiting_human" });
    view = reqSvc.get("req-wf-1");
    expect(view.derivedStatus).toBe("waiting_user");

    await wfPort.updateExecution("exec-1", { status: "success", exit: "success" });
    view = reqSvc.get("req-wf-1");
    expect(view.derivedStatus).toBe("open");
    db.close();
  });

  test("trigger scheduler fires onCircuitOpen once when 3 consecutive failures trip the circuit", async () => {
    const dir = makeTmpDir();
    const store = createFsWorkflowStore(dir);
    store.write(
      "nightly-check",
      {
        version: 1,
        id: "nightly-check",
        triggers: [{ type: "cron", cron: "0 4 * * *", enabled: true }],
        nodes: [
          { id: "start", type: "start" },
          { id: "done", type: "end", status: "success" },
        ],
        edges: [{ from: "start", to: "done" }],
      },
      { author: "user", summary: "init" },
    );

    const callbacks: Array<() => void> = [];
    const circuitEvents: Array<{ workflowId: string; consecutiveFailures: number }> = [];
    const scheduler = createWorkflowTriggerScheduler({
      workflowDir: dir,
      schedule: (_expr, fn) => {
        callbacks.push(fn);
        return { stop: () => {} };
      },
      startExecution: async () => ({ executionId: "never" }),
      listExecutions: async () => [
        { status: "failure", createdAt: 300 },
        { status: "failure", createdAt: 200 },
        { status: "failure", createdAt: 100 },
      ],
      onCircuitOpen: (ev) => {
        circuitEvents.push({
          workflowId: ev.workflowId,
          consecutiveFailures: ev.consecutiveFailures,
        });
      },
    });

    await scheduler.sync();
    expect(callbacks).toHaveLength(1);

    // Fire twice while circuit is tripped — onCircuitOpen must fire ONCE (no spam).
    callbacks[0]!();
    await new Promise((r) => setTimeout(r, 20));
    callbacks[0]!();
    await new Promise((r) => setTimeout(r, 20));

    expect(circuitEvents).toEqual([{ workflowId: "nightly-check", consecutiveFailures: 3 }]);
    await scheduler.dispose();
  });
});
