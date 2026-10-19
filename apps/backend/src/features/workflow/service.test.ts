import { describe, expect, test } from "bun:test";
import type { WorkflowDefinition } from "@chengchenccc/workflow";
import { parseWorkflow } from "@chengchenccc/workflow";
import { createWorkflowExecutionService } from "./service.js";

function makeDef(): WorkflowDefinition {
  return {
    version: 1,
    id: "wf",
    nodes: [
      { id: "start", type: "start" },
      {
        id: "s",
        type: "script",
        code: "x",
        output: [{ key: "val", type: "number" }],
        inputSchema: {
          type: "object",
          properties: { num: { type: "integer" } },
          required: ["num"],
        },
      },
      { id: "done", type: "end", status: "success" },
    ],
    edges: [
      { from: "start", to: "s" },
      { from: "s", to: "done" },
    ],
  };
}

function makeHumanDef(): WorkflowDefinition {
  return {
    version: 1,
    id: "wf",
    nodes: [
      { id: "start", type: "start" },
      { id: "h", type: "human", question: "ok?" },
      { id: "done", type: "end", status: "success" },
    ],
    edges: [
      { from: "start", to: "h" },
      { from: "h", to: "done" },
    ],
  };
}

function makeHumanTimeoutDef(timeoutMs: number): WorkflowDefinition {
  return {
    version: 1,
    id: "wf",
    nodes: [
      { id: "start", type: "start" },
      { id: "h", type: "human", question: "ok?", timeoutMs },
      { id: "done", type: "end", status: "success" },
    ],
    edges: [
      { from: "start", to: "h" },
      { from: "h", to: "done" },
    ],
  };
}

function makeHumanBranchDef(): WorkflowDefinition {
  return {
    version: 1,
    id: "wf",
    nodes: [
      { id: "start", type: "start" },
      { id: "h", type: "human", question: "ok?" },
      { id: "done", type: "end", status: "success" },
      { id: "rejected", type: "end", status: "failure" },
    ],
    edges: [
      { from: "start", to: "h" },
      { from: "h", to: "done", when: { "==": [{ var: "h.output.approved" }, true] } },
      { from: "h", to: "rejected", when: { "==": [{ var: "h.output.approved" }, false] } },
    ],
  };
}

function makeAgentDef(): WorkflowDefinition {
  return {
    version: 1,
    id: "wf",
    nodes: [
      { id: "start", type: "start" },
      { id: "a", type: "agent", agentId: "ag-1", output: [{ key: "val", type: "number" }] },
      { id: "done", type: "end", status: "success" },
    ],
    edges: [
      { from: "start", to: "a" },
      { from: "a", to: "done" },
    ],
  };
}

function makeRepoAgentDef(repo: string): WorkflowDefinition {
  return {
    version: 1,
    id: "wf",
    nodes: [
      { id: "start", type: "start" },
      { id: "a", type: "agent", agentId: "ag-1", repo, output: [{ key: "val", type: "number" }] },
      { id: "done", type: "end", status: "success" },
    ],
    edges: [
      { from: "start", to: "a" },
      { from: "a", to: "done" },
    ],
  };
}

function ramPort() {
  const executions = new Map<string, Record<string, unknown>>();
  const nodeRuns: Array<Record<string, unknown>> = [];
  const pendingHuman = new Map<string, Record<string, unknown>>();
  const events: Array<Record<string, unknown>> = [];
  return {
    executions,
    nodeRuns,
    pendingHuman,
    events,
    port: {
      createExecution: async (i: Record<string, unknown>) => {
        const r = { ...i, status: "running" };
        executions.set(i.executionId as string, r);
        return r;
      },
      getExecution: async (id: string) => executions.get(id) ?? null,
      updateExecution: async (id: string, patch: Record<string, unknown>) => {
        const r = executions.get(id);
        if (r) Object.assign(r, patch);
        return r;
      },
      appendNodeRun: async (i: Record<string, unknown>) => {
        const r = { seq: nodeRuns.length + 1, ...i };
        nodeRuns.push(r);
        return r;
      },
      // Same rule as the sqlite adapter: a patch means the node's latest row,
      // because a node holds one row per attempt (ADR 0042).
      updateNodeRun: async (_e: string, nodeId: string, patch: Record<string, unknown>) => {
        const r = nodeRuns.filter((x) => x.nodeId === nodeId).at(-1);
        if (r) Object.assign(r, patch);
        return r ?? null;
      },
      listNodeRuns: async (executionId: string) =>
        nodeRuns.filter((r) => r.executionId === executionId),
      appendExecutionEvent: async (e: Record<string, unknown>) => {
        events.push(e);
      },
      listExecutionEvents: async () => events,
      createPendingHuman: async (r: Record<string, unknown>) => {
        pendingHuman.set(`${r.executionId as string}:${r.nodeId as string}`, r);
        return r;
      },
      getPendingHuman: async (executionId: string, nodeId: string) =>
        pendingHuman.get(`${executionId}:${nodeId}`) ?? null,
      markPendingHumanResolved: async (executionId: string, nodeId: string) => {
        const r = pendingHuman.get(`${executionId}:${nodeId}`);
        if (r?.status !== "pending") return false;
        r.status = "resolved";
        return true;
      },
      listRunningExecutions: async () => [],
      listWaitingHumanExecutions: async () =>
        [...executions.values()].filter((r) => r.status === "waiting_human"),
    } as never,
  };
}

describe("createWorkflowExecutionService", () => {
  test("runs a linear workflow to terminal success via runToCompletion", async () => {
    const { port } = ramPort();
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {
        script: {
          run: async (_node: unknown, ctx: { input: Record<string, unknown> }) => ({
            output: { val: ctx.input.val },
          }),
        },
        human: { run: async () => ({ output: {} }) },
      } as never,
      idGen: () => "e1",
    });
    const result = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: makeDef(),
      input: { num: 7 },
    });
    expect(result.status).toBe("success");
    expect(result.exit).toBe("success");
  });

  test("input schema violation fails the node and the execution", async () => {
    const { port } = ramPort();
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: { script: { run: async () => ({ output: {} }) } } as never,
      idGen: () => "e1",
    });
    const result = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: makeDef(),
      input: { num: "not-a-number" },
    });
    expect(result.status).toBe("failure");
  });

  test("human node pauses at waiting_human, resolveHumanTask resumes to success", async () => {
    const { port } = ramPort();
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {} as never,
      idGen: () => "e1",
    });
    const paused = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: makeHumanDef(),
      input: {},
    });
    expect(paused.status).toBe("waiting_human");
    const resumed = await svc.resolveHumanTask("e1", "h", { approved: true });
    expect(resumed.status).toBe("success");
  });

  test("human answer nextNode cannot override when routing (M1)", async () => {
    const { port } = ramPort();
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {} as never,
      idGen: () => "e1",
    });
    const paused = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: makeHumanBranchDef(),
      input: {},
    });
    expect(paused.status).toBe("waiting_human");
    // answer says approved → `when` routes to done; the injected nextNode
    // (pre-M1 routing override) must be stripped, not followed.
    const resumed = await svc.resolveHumanTask("e1", "h", {
      approved: true,
      nextNode: "rejected",
    });
    expect(resumed.status).toBe("success");
  });

  test("a human node with timeoutMs expires, and a late answer loses the race", async () => {
    const { port, nodeRuns } = ramPort();
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {} as never,
      idGen: () => "e1",
    });
    const parked = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: makeHumanTimeoutDef(1000),
      input: {},
    });
    expect(parked.status).toBe("waiting_human");

    // The sweep terminalizes it and the node run carries the reason.
    expect(await svc.expireHumanTimeouts(Date.now() + 100_000)).toEqual(["e1"]);
    const settled = await svc.getExecution("e1");
    expect(settled?.status).toBe("failure");
    expect(settled?.exit).toBe("failure");
    expect(settled?.error).toContain('human task "h" timed out after 1000ms');
    expect(nodeRuns.find((r) => r.nodeId === "h")?.status).toBe("failed");

    // The claim was taken by the timeout: the answer arrives too late.
    await expect(svc.resolveHumanTask("e1", "h", { approved: true })).rejects.toThrow();
    expect((await svc.getExecution("e1"))?.status).toBe("failure");
    // A second sweep sees nothing waiting (no double terminalization).
    expect(await svc.expireHumanTimeouts(Date.now() + 200_000)).toEqual([]);
  });

  test("a human timeout is time-based, not immediate", async () => {
    const { port } = ramPort();
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {} as never,
      idGen: () => "e1",
    });
    await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: makeHumanTimeoutDef(60_000),
      input: {},
    });
    expect(await svc.expireHumanTimeouts()).toEqual([]);
    expect((await svc.getExecution("e1"))?.status).toBe("waiting_human");
    expect(await svc.expireHumanTimeouts(Date.now() + 60_001)).toEqual(["e1"]);
    expect((await svc.getExecution("e1"))?.status).toBe("failure");
  });

  test("a human node without timeoutMs still waits forever", async () => {
    const { port } = ramPort();
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {} as never,
      idGen: () => "e1",
    });
    await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: makeHumanDef(),
      input: {},
    });
    expect(await svc.expireHumanTimeouts(Date.now() + 10 ** 9)).toEqual([]);
    expect((await svc.getExecution("e1"))?.status).toBe("waiting_human");
  });

  test("an agent node with repo binds the conversation to that project", async () => {
    const { port } = ramPort();
    const created: Array<Record<string, unknown>> = [];
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {} as never,
      idGen: () => "e1",
      agentRunService: {
        getRun: async () => ({
          status: "completed",
          terminalResult: {
            status: "completed",
            messages: [{ role: "assistant", text: '{"val": 1}' }],
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
        createConversation: (input: Record<string, unknown>) => {
          created.push(input);
        },
      } as never,
      conversationService: {
        postMessage: async () => ({ triggeredRuns: [{ runId: "r1", queued: true }] }),
      } as never,
      resolveDefaultModel: async () => ({ backendKind: "oma", modelId: "x" }),
      agentProjects: async () => ["proj-1"],
    });
    const result = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: makeRepoAgentDef("proj-1"),
      input: {},
    });
    expect(result.status).toBe("success");
    // The project id on the conversation IS the feature: dispatch resolves the
    // agent's worktree for that project from it (resolveWorkspace), so a node
    // whose repo never reaches the conversation runs in the wrong place.
    expect(created[0]?.projectId).toBe("proj-1");
    expect(created[0]?.conversationId).toBe("workflow:e1:a");
  });

  test("an agent node with an unattached repo fails with a usable error", async () => {
    const { port } = ramPort();
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {} as never,
      idGen: () => "e1",
      agentRunService: { getRun: async () => ({ status: "completed" }) } as never,
      agentRunExecution: {
        dispatch: async () => {},
        subscribe: async function* () {},
      } as never,
      convPort: { getConversation: () => null, createConversation: () => {} } as never,
      conversationService: { postMessage: async () => ({ triggeredRuns: [] }) } as never,
      resolveDefaultModel: async () => ({ backendKind: "oma", modelId: "x" }),
      agentProjects: async () => ["some-other-project"],
    });
    const result = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: makeRepoAgentDef("proj-1"),
      input: {},
    });
    // Never silently run in the default workspace: the node names the project
    // and how to attach it.
    expect(result.status).toBe("failure");
    expect(result.error).toContain("has not attached project proj-1");
  });

  test("agent node runs a child run and parses JSON output", async () => {
    const { port, nodeRuns } = ramPort();
    const posted: Array<{ permissionMode?: string }> = [];
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {} as never,
      idGen: () => "e1",
      agentRunService: {
        enqueueAndAcquire: async () => ({ acquired: true, run: { runId: "r1" } }),
        getRun: async () => ({
          status: "completed",
          terminalResult: {
            status: "completed",
            messages: [{ role: "assistant", text: '{"val": 1}' }],
          },
        }),
      } as never,
      agentRunExecution: {
        dispatch: async () => {},
        subscribe: async function* () {
          yield { type: "status", status: "completed" };
        },
      } as never,
      convPort: { getConversation: () => null, createConversation: () => {} } as never,
      conversationService: {
        postMessage: async (input: { permissionMode?: string }) => {
          posted.push(input);
          return { triggeredRuns: [{ runId: "r1", queued: true }] };
        },
      } as never,
      resolveDefaultModel: async () => ({ backendKind: "oma", modelId: "x" }),
    });
    const result = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: makeAgentDef(),
      input: {},
    });

    // A node conversation never shows up in the conversation list, so nothing
    // can answer an approval prompt raised there: the dispatch pins yolo
    // instead of inheriting the agent's ask/auto (measured: a nightly node sat
    // waiting on "classifier unavailable" until the workflow was cancelled).
    expect(posted[0]?.permissionMode).toBe("yolo");
    expect(result.status).toBe("success");
    expect(nodeRuns.find((r) => r.nodeId === "a")!.output).toEqual({ val: 1 });
  });

  test("agent node retries with schema error feedback in prompt", async () => {
    const { port, nodeRuns } = ramPort();
    const posted: string[] = [];
    const postedRuns: string[] = [];
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {} as never,
      idGen: () => "e1",
      agentRunService: {
        getRun: async (runId: string) => ({
          status: "completed",
          terminalResult:
            runId === "r1"
              ? { status: "completed", messages: [{ role: "assistant", text: '{"wrong": 1}' }] }
              : { status: "completed", messages: [{ role: "assistant", text: '{"val": 1}' }] },
        }),
      } as never,
      agentRunExecution: {
        dispatch: async () => {},
        subscribe: async function* () {
          yield { type: "status", status: "completed" };
        },
      } as never,
      convPort: { getConversation: () => null, createConversation: () => {} } as never,
      conversationService: {
        postMessage: async ({ content }: { content: unknown }) => {
          posted.push(String(content));
          const runId = posted.length === 1 ? "r1" : "r2";
          postedRuns.push(runId);
          return { triggeredRuns: [{ runId, queued: true }] };
        },
      } as never,
      resolveDefaultModel: async () => ({ backendKind: "oma", modelId: "x" }),
    });
    const def = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        {
          id: "a",
          type: "agent",
          agentId: "ag-1",
          retry: 1,
          outputSchema: {
            type: "object",
            properties: { val: { type: "number" } },
            required: ["val"],
          },
        },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "done" },
      ],
    });
    const result = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: def,
      input: {},
    });
    expect(result.status).toBe("success");
    expect(posted.length).toBe(2);
    expect(posted[1]).toContain("previous attempt failed");
    // #42: the correction is a NEW input identity — a distinct run, and the
    // node's persisted runId follows it. Nothing may reuse r1 or treat the
    // retry as a replay of the failed attempt.
    expect(postedRuns).toEqual(["r1", "r2"]);
    expect(nodeRuns.find((r) => r.nodeId === "a")!.runId).toBe("r2");
    expect(nodeRuns.find((r) => r.nodeId === "a")!.output).toEqual({ val: 1 });
  });

  test("conditional edge routes by source node output", async () => {
    const { port } = ramPort();
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {
        script: {
          run: async (_n: unknown, ctx: { input: Record<string, unknown> }) => ({
            output: { severity: ctx.input.severity },
          }),
        },
      } as never,
      idGen: () => "e1",
    });
    const def = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "script", code: "x" },
        { id: "done", type: "end", status: "success" },
        { id: "abort", type: "end", status: "failure" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "done", when: { "==": [{ var: "a.output.severity" }, "high"] } },
        { from: "a", to: "abort", when: { "==": [{ var: "a.output.severity" }, "critical"] } },
      ],
    });
    const ok = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: def,
      input: { severity: "high" },
    });
    expect(ok.exit).toBe("success");
    const bad = await svc.runToCompletion("e2", {
      workflowId: "wf",
      definition: def,
      input: { severity: "critical" },
    });
    expect(bad.exit).toBe("failure");
  });
});

describe("agent node ↔ AgentRun lifecycle (#workflow-acp)", () => {
  const baseDeps = () => {
    const { port, nodeRuns } = ramPort();
    return {
      port,
      nodeRuns,
      postMessage: async () => ({ triggeredRuns: [{ runId: "r1", queued: true }] }),
    };
  };

  test("commit_failed is not success: it waits for a canonical completion", async () => {
    const { port, postMessage } = baseDeps();
    const statuses = ["commit_failed", "commit_failed", "completed"];
    let polls = 0;
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {} as never,
      idGen: () => "e1",
      agentNodeTimeoutMs: 5000,
      agentRunService: {
        getRun: async () => {
          const status = statuses[Math.min(polls, statuses.length - 1)]!;
          polls += 1;
          return {
            status,
            // commit_failed carries the child outcome but is NOT canonical.
            terminalResult: {
              status: "completed",
              messages: [{ role: "assistant", text: '{"val": 1}' }],
            },
          };
        },
      } as never,
      agentRunExecution: { dispatch: async () => {}, stop: async () => {} } as never,
      convPort: { getConversation: () => null, createConversation: () => {} } as never,
      conversationService: { postMessage } as never,
      resolveDefaultModel: async () => ({ backendKind: "oma", modelId: "x" }),
    });
    const result = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: makeAgentDef(),
      input: {},
    });
    expect(result.status).toBe("success");
    expect(polls).toBeGreaterThanOrEqual(3); // it really polled through commit_failed
  });

  test("a cancelled execution stops its node's run instead of leaving it parked", async () => {
    const { port, postMessage } = baseDeps();
    const stopped: string[] = [];
    let polls = 0;
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {} as never,
      idGen: () => "e1",
      agentNodeTimeoutMs: 60_000,
      agentRunService: {
        // The run never leaves `waiting`: this is the parked shape a node can
        // land in when its gate asks and no surface can answer.
        getRun: async () => {
          polls += 1;
          return { status: "waiting", terminalResult: undefined };
        },
      } as never,
      agentRunExecution: {
        dispatch: async () => {},
        stop: async (runId: string) => {
          stopped.push(runId);
        },
      } as never,
      convPort: { getConversation: () => null, createConversation: () => {} } as never,
      conversationService: { postMessage } as never,
      resolveDefaultModel: async () => ({ backendKind: "oma", modelId: "x" }),
    });

    const running = svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: makeAgentDef(),
      input: {},
    });
    // Cancel while the node is still polling.
    const cancelAfterFirstPoll = (async () => {
      while (polls === 0) await new Promise((r) => setTimeout(r, 20));
      await svc.cancelExecution("e1");
    })();
    // The drive loop catches the cancel and terminalizes as failure; what this
    // test owns is whether the node's run was stopped on the way out.
    const result = await running;
    await cancelAfterFirstPoll;
    expect(result.status).toBe("failure");

    // Without this stop the run stays `waiting` forever: its child keeps
    // idling (measured: over an hour) and the silence watchdog exempts it
    // because "someone is being asked".
    expect(stopped).toEqual(["r1"]);
  }, 15_000);

  test("a waiting run pauses the workflow clock instead of timing out", async () => {
    const { port, postMessage } = baseDeps();
    let polls = 0;
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {} as never,
      idGen: () => "e1",
      agentNodeTimeoutMs: 5000,
      agentRunService: {
        getRun: async () => {
          polls += 1;
          // Wait 4 polls (well past the 30ms running budget), then complete.
          return polls <= 4
            ? { status: "waiting" }
            : {
                status: "completed",
                terminalResult: {
                  status: "completed",
                  messages: [{ role: "assistant", text: '{"val": 1}' }],
                },
              };
        },
      } as never,
      agentRunExecution: { dispatch: async () => {}, stop: async () => {} } as never,
      convPort: { getConversation: () => null, createConversation: () => {} } as never,
      conversationService: { postMessage } as never,
      resolveDefaultModel: async () => ({ backendKind: "oma", modelId: "x" }),
    });
    const result = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: makeAgentDef(),
      input: {},
    });
    expect(result).toMatchObject({ status: "success" });
  });

  test("timeout cancels the child first, then fails the node", async () => {
    const { port, postMessage } = baseDeps();
    const stopped: string[] = [];
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {} as never,
      idGen: () => "e1",
      agentNodeTimeoutMs: 20,
      agentRunService: {
        getRun: async () => ({ status: "running" }),
      } as never,
      agentRunExecution: {
        dispatch: async () => {},
        stop: async (runId: string) => {
          stopped.push(runId);
        },
      } as never,
      convPort: { getConversation: () => null, createConversation: () => {} } as never,
      conversationService: { postMessage } as never,
      resolveDefaultModel: async () => ({ backendKind: "oma", modelId: "x" }),
    });
    const result = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: makeAgentDef(),
      input: {},
    });
    expect(result.status).toBe("failure");
    expect(result.error).toContain("timed out");
    expect(stopped).toEqual(["r1"]);
  });
});

describe("#44: restart recovery reuses the persisted run, never re-posts", () => {
  test("an existing nodeRun.runId is polled, not re-triggered", async () => {
    const { port, nodeRuns } = ramPort();
    // Simulate a restart: the node already persisted its runId.
    nodeRuns.push({
      executionId: "e1",
      nodeId: "a",
      runId: "r-existing",
      status: "running",
      output: null,
    } as never);
    let posted = 0;
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {} as never,
      idGen: () => "e1",
      agentRunService: {
        getRun: async (runId: string) => ({
          status: "completed",
          terminalResult: {
            status: "completed",
            messages: [{ role: "assistant", text: '{"val": 1}' }],
          },
          runId,
        }),
      } as never,
      agentRunExecution: { dispatch: async () => {}, stop: async () => {} } as never,
      convPort: { getConversation: () => null, createConversation: () => {} } as never,
      conversationService: {
        postMessage: async () => {
          posted += 1;
          return { triggeredRuns: [{ runId: "r-new", queued: true }] };
        },
      } as never,
      resolveDefaultModel: async () => ({ backendKind: "oma", modelId: "x" }),
    });
    const result = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: makeAgentDef(),
      input: {},
    });
    expect(result.status).toBe("success");
    expect(posted).toBe(0); // recovery never re-sends the node prompt
    expect(nodeRuns.find((r) => r.nodeId === "a")!.runId).toBe("r-existing");
    expect(nodeRuns.find((r) => r.nodeId === "a")!.output).toEqual({ val: 1 });
  });
});

/** ADR 0042 P3: rework as new attempts — rows, the budget exits and the two
 *  human decisions, through the real drive loop. */
describe("rework in the execution service", () => {
  const reworkDef = (onExhausted: "fail" | "human", maxAttempts = 2) =>
    parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "build", type: "script", code: "x", output: [{ key: "artifact", type: "string" }] },
        { id: "review", type: "script", code: "x", output: [{ key: "feedback", type: "string" }] },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "build" },
        { from: "build", to: "review" },
        { from: "review", to: "done" },
        {
          from: "review",
          to: "build",
          kind: "rework",
          budget: { maxAttempts, onExhausted },
          when: { "==": [{ var: "review.output.feedback" }, "redo"] },
        },
      ],
    });

  /** A build that produces vN and a review that rejects v1 only: the second
   *  round is what the rework has to produce. Records what each node saw. */
  function runner(seen: Array<{ nodeId: string; input: Record<string, unknown> }>) {
    return {
      run: async (
        node: { id: string },
        ctx: { input: Record<string, unknown> },
      ): Promise<{ output: Record<string, unknown> }> => {
        seen.push({ nodeId: node.id, input: ctx.input });
        if (node.id === "build") {
          return { output: { artifact: `v${(ctx.input.attempt as number | undefined) ?? 1}` } };
        }
        if (node.id === "review") {
          return { output: { feedback: ctx.input.artifact === "v1" ? "redo" : "ship" } };
        }
        return { output: {} };
      },
    };
  }

  /** The drive loop after a human decision is fire-and-forget; give it a moment
   *  to reach a terminal status instead of asserting mid-flight. */
  const waitFor = async (
    predicate: () => boolean | Promise<boolean>,
    ms = 4000,
  ): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return await predicate();
  };

  test("independent branches in one wave run concurrently", async () => {
    const fake = ramPort();
    let inFlight = 0;
    let maxInFlight = 0;
    const svc = createWorkflowExecutionService({
      port: fake.port,
      nodeRunners: {
        script: {
          run: async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            // Long enough that a serial loop could never overlap.
            await new Promise((r) => setTimeout(r, 40));
            inFlight -= 1;
            return { output: {} };
          },
        },
      } as never,
      idGen: () => "e-wave",
    });
    const definition = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "script", code: "x" },
        { id: "b", type: "script", code: "x" },
        // The all-join is what proves both branches really completed before the
        // drive moved on; any-of would have fired the end after the first.
        { id: "join", type: "script", code: "x", join: "all" },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "start", to: "b" },
        { from: "a", to: "join" },
        { from: "b", to: "join" },
        { from: "join", to: "done" },
      ],
    });
    const result = await svc.runToCompletion("e-wave", {
      workflowId: "wf",
      definition,
      input: {},
    });
    expect(result.status).toBe("success");
    expect(maxInFlight).toBe(2);
  }, 15_000);

  test("a rejected verdict runs the target again, as a new attempt", async () => {
    const fake = ramPort();
    const seen: Array<{ nodeId: string; input: Record<string, unknown> }> = [];
    const svc = createWorkflowExecutionService({
      port: fake.port,
      nodeRunners: { script: runner(seen) } as never,
      idGen: () => "e-rework",
    });
    const result = await svc.runToCompletion("e-rework", {
      workflowId: "wf",
      definition: reworkDef("fail"),
      input: {},
    });
    expect(result.status).toBe("success");
    // Two attempts of build and of review, each a row of its own.
    const rows = fake.nodeRuns as Array<{ nodeId: string; status: string }>;
    const build = rows.filter((r) => r.nodeId === "build").map((r) => r.status);
    expect(build).toEqual(["superseded", "completed"]);
    expect(rows.filter((r) => r.nodeId === "review").map((r) => r.status)).toEqual([
      "superseded",
      "completed",
    ]);
    // The retry was told which round it is and why.
    const secondBuild = seen.filter((r) => r.nodeId === "build")[1];
    expect(secondBuild?.input.attempt).toBe(2);
    expect(secondBuild?.input.rework).toEqual({ from: "review", reason: "redo" });
    // And it produced the round the review could accept.
    expect(seen.filter((r) => r.nodeId === "review")[1]?.input.artifact).toBe("v2");
    const events = fake.events as Array<{ event: string; data: Record<string, unknown> }>;
    expect(events.some((e) => e.event === "rework_requested")).toBe(true);
  });

  test("a spent budget ends the execution with the round and the last reason", async () => {
    const fake = ramPort();
    const seen: Array<{ nodeId: string; input: Record<string, unknown> }> = [];
    const svc = createWorkflowExecutionService({
      port: fake.port,
      nodeRunners: { script: runner(seen) } as never,
      idGen: () => "e-fail",
    });
    const result = await svc.runToCompletion("e-fail", {
      workflowId: "wf",
      definition: reworkDef("fail", 1),
      input: {},
    });
    expect(result.status).toBe("failure");
    expect(result.error).toContain("rework budget");
    expect(result.error).toContain("redo");
  });

  test("a human may grant the attempt the budget refused", async () => {
    const fake = ramPort();
    const seen: Array<{ nodeId: string; input: Record<string, unknown> }> = [];
    const svc = createWorkflowExecutionService({
      port: fake.port,
      nodeRunners: { script: runner(seen) } as never,
      idGen: () => "e-grant",
    });
    const parked = await svc.runToCompletion("e-grant", {
      workflowId: "wf",
      definition: reworkDef("human", 1),
      input: {},
    });
    expect(parked.status).toBe("waiting_human");
    const gate = await svc.getPendingHuman("e-grant", "build#budget");
    expect(gate?.status).toBe("pending");
    expect((gate?.form as { budgetGate?: { maxAttempts?: number } })?.budgetGate?.maxAttempts).toBe(
      1,
    );
    // A gate parks under a synthetic id (`<node>#budget`) no DSL node answers
    // to, so it declares no timeout: the sweep must leave it alone, not crash.
    expect(await svc.expireHumanTimeouts(Date.now() + 10 ** 9)).toEqual([]);
    expect((await svc.getExecution("e-grant"))?.status).toBe("waiting_human");

    await svc.resolveHumanTask("e-grant", "build#budget", { decision: "grant" });
    const settled = await waitFor(
      async () => (await svc.getExecution("e-grant"))?.status === "success",
    );
    expect(settled).toBe(true);
    // The granted attempt is the one the budget refused, and it carries the
    // verdict that caused it.
    expect(seen.filter((r) => r.nodeId === "build")[1]?.input.attempt).toBe(2);
  });

  test("a human verdict sends work back too", async () => {
    // The review is a human gate here: its answer arrives over HTTP, not from
    // the drive loop's completion block, and it still has to rework. (Found
    // live: the answer was recorded, routing continued, no retry happened.)
    const definition = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "build", type: "script", code: "x", output: [{ key: "artifact", type: "string" }] },
        {
          id: "review",
          type: "human",
          question: "ship?",
          form: { verdict: { type: "enum", options: ["ship", "redo"] } },
        },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "build" },
        { from: "build", to: "review" },
        { from: "review", to: "done" },
        {
          from: "review",
          to: "build",
          kind: "rework",
          budget: { maxAttempts: 2, onExhausted: "fail" },
          when: { "==": [{ var: "review.output.verdict" }, "redo"] },
        },
      ],
    });
    const fake = ramPort();
    const seen: Array<{ nodeId: string; input: Record<string, unknown> }> = [];
    const svc = createWorkflowExecutionService({
      port: fake.port,
      nodeRunners: {
        script: {
          run: async (node: { id: string }, ctx: { input: Record<string, unknown> }) => {
            seen.push({ nodeId: node.id, input: ctx.input });
            return { output: { artifact: `v${(ctx.input.attempt as number | undefined) ?? 1}` } };
          },
        },
        human: { run: async () => ({ output: {} }) },
      } as never,
      idGen: () => "e-human-rework",
    });
    await svc.runToCompletion("e-human-rework", {
      workflowId: "wf",
      definition,
      input: {},
    });
    await svc.resolveHumanTask("e-human-rework", "review", {
      answers: [{ id: "verdict", selectedValues: ["redo"] }],
    });
    const retried = await waitFor(() => seen.filter((r) => r.nodeId === "build").length >= 2);
    expect(retried).toBe(true);
    expect(seen.filter((r) => r.nodeId === "build")[1]?.input.attempt).toBe(2);
    const rows = fake.nodeRuns as Array<{ nodeId: string; status: string }>;
    expect(rows.filter((r) => r.nodeId === "build").map((r) => r.status)).toEqual([
      "superseded",
      "completed",
    ]);
    const events = fake.events as Array<{ event: string }>;
    expect(events.some((e) => e.event === "rework_requested")).toBe(true);

    // The reworked review gates AGAIN: the same node parks twice in one
    // execution, and the second gate must not collide with the first's row.
    await waitFor(async () => (await svc.getPendingHuman("e-human-rework", "review")) !== null);
    const second = await svc.getPendingHuman("e-human-rework", "review");
    expect(second?.status).toBe("pending");
    await svc.resolveHumanTask("e-human-rework", "review", {
      answers: [{ id: "verdict", selectedValues: ["ship"] }],
    });
    const settled = await waitFor(
      async () => (await svc.getExecution("e-human-rework"))?.status === "success",
    );
    expect(settled).toBe(true);
  });

  test("a process that never saw the verdict still owes the retry", async () => {
    // The rows are the only rework state there is: a fresh service over the same
    // port must resume from what the previous process left behind. This is the
    // restart half of "no in-memory state", and it is why nothing is cached.
    const fake = ramPort();
    const definition = reworkDef("fail");
    (fake.executions as Map<string, Record<string, unknown>>).set("e-restart", {
      executionId: "e-restart",
      workflowId: "wf",
      definition,
      input: {},
      store: {},
      status: "running",
      triggeredBy: "manual",
      createdAt: Date.now(),
    });
    const runs = fake.nodeRuns as Array<Record<string, unknown>>;
    runs.push(
      {
        seq: 1,
        executionId: "e-restart",
        nodeId: "start",
        status: "completed",
        order: 0,
        routedTo: ["build"],
      },
      {
        seq: 2,
        executionId: "e-restart",
        nodeId: "build",
        status: "superseded",
        order: 1,
        output: { artifact: "v1" },
      },
      {
        seq: 3,
        executionId: "e-restart",
        nodeId: "review",
        status: "superseded",
        order: 2,
        output: { feedback: "redo" },
      },
    );
    const seen: Array<{ nodeId: string; input: Record<string, unknown> }> = [];
    const svc = createWorkflowExecutionService({
      // The double casts to `never` for the port shape, so spread it as a
      // record first: spreading `never` is a type error nothing else catches
      // (the suite runs without typechecking, so it slipped through once).
      port: {
        ...(fake.port as unknown as Record<string, unknown>),
        listRunningExecutions: async () => [fake.executions.get("e-restart")],
      } as never,
      nodeRunners: { script: runner(seen) } as never,
      idGen: () => "e-restart",
    });
    await svc.recover();
    const settled = await waitFor(
      async () => (await svc.getExecution("e-restart"))?.status === "success",
    );
    expect(settled).toBe(true);
    // The retry is attempt 2 and it was told why, from the row history alone.
    expect(seen.filter((r) => r.nodeId === "build")[0]?.input.attempt).toBe(2);
    expect(seen.filter((r) => r.nodeId === "build")[0]?.input.rework).toEqual({
      from: "review",
      reason: "redo",
    });
  });

  test("a rejected gate ends the execution", async () => {
    const fake = ramPort();
    const seen: Array<{ nodeId: string; input: Record<string, unknown> }> = [];
    const svc = createWorkflowExecutionService({
      port: fake.port,
      nodeRunners: { script: runner(seen) } as never,
      idGen: () => "e-reject",
    });
    await svc.runToCompletion("e-reject", {
      workflowId: "wf",
      definition: reworkDef("human", 1),
      input: {},
    });
    const row = await svc.resolveHumanTask("e-reject", "build#budget", { decision: "reject" });
    expect(row.status).toBe("failure");
    expect(row.error).toContain("rejected");
  });
});
