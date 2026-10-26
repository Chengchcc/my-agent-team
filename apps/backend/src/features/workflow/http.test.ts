import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowDefinition } from "@chengchenccc/workflow";
import { Elysia } from "elysia";
import { HttpError } from "../../infra/errors.js";
import { workflowRoutes } from "./http.js";
import type { WorkflowExecutionService } from "./service.js";

const def: WorkflowDefinition = {
  version: 1,
  id: "wf",
  nodes: [
    { id: "start", type: "start" },
    { id: "done", type: "end", status: "success" },
  ],
  edges: [{ from: "start", to: "done" }],
};

const fakeService: WorkflowExecutionService = {
  runToCompletion: async () => ({
    executionId: "e1",
    workflowId: "wf",
    definition: def,
    input: {},
    store: {},
    status: "success",
    exit: "success",
    createdAt: 0,
  }),
  startExecution: async (input) => ({
    executionId: "e1",
    workflowId: input.workflowId,
    definition: input.definition,
    input: input.input,
    store: {},
    status: "running",
    createdAt: 1,
  }),
  resolveHumanTasks: async () => [],
  expireHumanTimeouts: async () => [],
  resolveHumanTask: async (executionId, _nodeId, _answer) => ({
    executionId,
    workflowId: "wf",
    definition: def,
    input: {},
    store: {},
    status: "success",
    exit: "success",
    createdAt: 1,
  }),
  getExecution: async (id) => ({
    executionId: id,
    workflowId: "wf",
    definition: def,
    input: {},
    store: {},
    status: "running",
    createdAt: 1,
  }),
  listNodeRuns: async () => [],
  listExecutionEvents: async () => [],
  getPendingHuman: async () => null,
  deleteExecution: async () => true,
  cancelExecution: async () => null,
  listExecutions: async () => [
    {
      executionId: "e1",
      workflowId: "wf",
      definition: def,
      input: {},
      store: {},
      status: "success",
      exit: "success",
      createdAt: 1,
    },
  ],
  recover: async () => {},
};

const dir = mkdtempSync(join(tmpdir(), "wf-http-"));
// Starting an execution reads a real file now (a typo is a 404, not a 500), so
// the fixture has to exist the same way it does in a deployment.
writeFileSync(join(dir, "oncall.workflow.json"), JSON.stringify(def));

const app = workflowRoutes({
  workflowExecutionService: fakeService,
  loadWorkflow: async () => JSON.stringify(def),
  workflowDir: dir,
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("workflow http", () => {
  test("POST /api/workflow-executions creates an execution", async () => {
    const resp = await app.handle(
      new Request("http://localhost/api/workflow-executions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowRef: { repo: "org/flows", path: "oncall.workflow.json" },
          input: { issueUrl: "u" },
        }),
      }),
    );
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { executionId: string };
    expect(body.executionId).toBe("e1");
  });

  test("POST /api/workflow-executions no longer demands the legacy repo field", async () => {
    // Definitions load from the local workflows dir; `repo` was required and
    // ignored, so every caller wrote a magic string. It stays accepted.
    const resp = await app.handle(
      new Request("http://localhost/api/workflow-executions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowRef: { path: "oncall.workflow.json" },
          input: { issueUrl: "u" },
        }),
      }),
    );
    expect(resp.status).toBe(201);
  });

  test("a definition that does not exist is a 404, not a 500", async () => {
    // The status mapping lives in app.ts's global onError; a bare router has
    // none, so this mounts the same three lines. The claim under test is the
    // router's own: a missing file is a client error naming the definition,
    // never an ENOENT surfacing as "Internal server error".
    const withMapping = new Elysia()
      .onError({ as: "global" }, ({ error, set }) => {
        if (error instanceof HttpError) {
          set.status = error.status;
          return { error: error.message };
        }
        set.status = 500;
        return { error: "unmapped" };
      })
      .use(
        workflowRoutes({
          workflowExecutionService: fakeService,
          loadWorkflow: async () => JSON.stringify(def),
          workflowDir: dir,
        }),
      );
    const json = { "content-type": "application/json" };
    const start = await withMapping.handle(
      new Request("http://localhost/api/workflow-executions", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ workflowRef: { path: "nope.workflow.json" } }),
      }),
    );
    expect(start.status).toBe(404);
    expect(((await start.json()) as { error: string }).error).toContain("nope.workflow.json");

    const one = await withMapping.handle(
      new Request("http://localhost/api/workflow-definitions/nope"),
    );
    expect(one.status).toBe(404);

    const dry = await withMapping.handle(
      new Request("http://localhost/api/workflow-definitions/nope/dry-run", {
        method: "POST",
        headers: json,
        body: JSON.stringify({}),
      }),
    );
    expect(dry.status).toBe(404);

    // A definition that DOES exist still reads.
    const present = await withMapping.handle(
      new Request("http://localhost/api/workflow-definitions/oncall"),
    );
    expect(present.status).toBe(200);
  });

  test("GET /api/workflow-executions returns a list", async () => {
    const resp = await app.handle(new Request("http://localhost/api/workflow-executions"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { executions: Array<{ executionId: string }> };
    expect(body.executions[0]!.executionId).toBe("e1");
  });

  test("workflow definition list/get/put/delete roundtrip", async () => {
    const put = await app.handle(
      new Request("http://localhost/api/workflow-definitions/wf", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definition: def }),
      }),
    );
    expect(put.status).toBe(200);
    const get = await app.handle(new Request("http://localhost/api/workflow-definitions/wf"));
    const getBody = (await get.json()) as { definition: { id: string } };
    expect(getBody.definition.id).toBe("wf");
    const list = await app.handle(new Request("http://localhost/api/workflow-definitions"));
    const listBody = (await list.json()) as { definitions: Array<{ workflowId: string }> };
    // Contains, not index 0: the list is a directory read, and asserting a
    // position makes the test depend on readdir order.
    expect(listBody.definitions.map((d) => d.workflowId)).toContain("wf");
    const del = await app.handle(
      new Request("http://localhost/api/workflow-definitions/wf", { method: "DELETE" }),
    );
    expect(del.status).toBe(200);
  });

  test("POST human-task resolves", async () => {
    const resp = await app.handle(
      new Request("http://localhost/api/workflow-executions/e1/human-task", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: "h", answer: { approved: true } }),
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { status: string };
    expect(body.status).toBe("success");
  });

  test("workflow definition dry-run returns exit", async () => {
    await app.handle(
      new Request("http://localhost/api/workflow-definitions/wf", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definition: def }),
      }),
    );
    const resp = await app.handle(
      new Request("http://localhost/api/workflow-definitions/wf/dry-run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: {}, mockOutputs: {} }),
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { exit: string; steps: Array<{ nodeId: string }> };
    expect(body.exit).toBe("success");
    expect(body.steps.some((st) => st.nodeId === "start")).toBe(true);
  });

  test("GET trace returns execution events and nodeRuns", async () => {
    const resp = await app.handle(new Request("http://localhost/api/workflow-executions/e1/trace"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      execution: { executionId: string };
      events: unknown[];
      nodeRuns: unknown[];
    };
    expect(body.execution.executionId).toBe("e1");
    expect(Array.isArray(body.events)).toBe(true);
    expect(Array.isArray(body.nodeRuns)).toBe(true);
  });
});

describe("workflow webhook trigger", () => {
  const tokens = new Map<string, string>();
  const calls: Array<{ triggeredBy?: string; input?: Record<string, unknown> }> = [];
  const trigApp = workflowRoutes({
    workflowExecutionService: {
      ...fakeService,
      startExecution: async (input: Parameters<typeof fakeService.startExecution>[0]) => {
        calls.push(input);
        return { executionId: "e_trig", status: "running" };
      },
    } as typeof fakeService,
    loadWorkflow: async () => JSON.stringify(def),
    workflowDir: dir,
    getTriggerToken: async (id) => tokens.get(id),
    setTriggerToken: async (id, token) => {
      tokens.set(id, token);
    },
  });

  test("rotate returns a token, wrong token is 401, right token starts with the payload", async () => {
    const rot = await trigApp.handle(
      new Request("http://localhost/api/workflow-definitions/wf-x/trigger-token", {
        method: "POST",
      }),
    );
    expect(rot.status).toBe(200);
    const { token } = (await rot.json()) as { token: string };
    expect(typeof token).toBe("string");
    expect((token as string).length).toBe(48);

    const wrong = await trigApp.handle(
      new Request("http://localhost/api/workflow-triggers/wf-x", {
        method: "POST",
        headers: { "content-type": "application/json", "x-trigger-token": "nope" },
        body: JSON.stringify({ issue: 7 }),
      }),
    );
    expect(wrong.status).toBe(401);
    expect(calls).toHaveLength(0);

    // No token ever issued for this one: same 401, indistinguishable.
    const none = await trigApp.handle(
      new Request("http://localhost/api/workflow-triggers/wf-other", {
        method: "POST",
        headers: { "content-type": "application/json", "x-trigger-token": token },
        body: "{}",
      }),
    );
    expect(none.status).toBe(401);

    const okResp = await trigApp.handle(
      new Request("http://localhost/api/workflow-triggers/wf-x", {
        method: "POST",
        headers: { "content-type": "application/json", "x-trigger-token": token },
        body: JSON.stringify({ issue: 7, title: "bug" }),
      }),
    );
    expect(okResp.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.triggeredBy).toBe("webhook");
    expect(calls[0]?.input).toEqual({ issue: 7, title: "bug" });
  });
});
