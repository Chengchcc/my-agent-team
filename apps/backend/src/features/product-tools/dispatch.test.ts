import { describe, expect, test } from "bun:test";
import {
  createProductToolsDispatch,
  frameHandbackInput,
  frameReportInput,
  frameResultInput,
  PRODUCT_TOOLS,
  toolsForRole,
  verificationLine,
} from "./dispatch.js";
import type { ProductToolsService } from "./service.js";

/** Records every service call and answers with a fixed content string. */
function stubService(answer: string | Error = "ok") {
  const calls: Array<Record<string, unknown>> = [];
  const service = {
    call: async (input: Record<string, unknown>) => {
      calls.push(input);
      if (answer instanceof Error) throw answer;
      return { content: answer };
    },
  } as unknown as ProductToolsService;
  return { service, calls };
}

const caller = { runId: "run-1", agentId: "agent-1" };

describe("product-tools dispatch (the rail-neutral half)", () => {
  test("lists every product tool with an input schema", () => {
    const { service } = stubService();
    const { tools } = createProductToolsDispatch({ service }).listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "history_recent",
      "history_search",
      "history_around",
      "history_retain",
      "todo_write",
      "dispatch",
      "handback",
      "remember",
      "steer_worker",
      "cancel_worker",
      "report",
      "wiki_read",
      "wiki_query",
      "wiki_create",
      "wiki_patch",
      "wiki_lint",
      "wiki_source_add",
      "answer_worker_request",
      "project_push",
      "project_propose",
      "project_list",
      "project_detail",
      "project_attach",
      "requirement_track",
      "requirement_query",
      "team_list",
      "ask_question",
      "artifact_upload",
      "artifact_download",
      "remind_me",
      "reminder_list",
      "reminder_cancel",
      "workflow_list",
      "workflow_read",
      "workflow_save",
      "workflow_delete",
      "workflow_run",
      "workflow_status",
      "workflow_cancel",
    ]);
    for (const tool of tools) {
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  test("keys the call from the authenticated run and the child's callId", async () => {
    const { service, calls } = stubService("done");
    const dispatch = createProductToolsDispatch({ service });
    const result = await dispatch.call({
      caller,
      name: "todo_write",
      args: { items: [] },
      metaIdentity: { conversationId: "conv-1", callId: "toolu-9" },
    });
    expect(result).toEqual({ content: "done" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      identity: { runId: "run-1", agentId: "agent-1", conversationId: "conv-1" },
      callId: "toolu-9",
      idempotencyKey: "run-1:toolu-9",
      tool: "todo_write",
    });
  });

  test("a stale identity echo in the arguments cannot move the run", async () => {
    const { service, calls } = stubService();
    await createProductToolsDispatch({ service }).call({
      caller,
      name: "history_recent",
      args: { identity: { runId: "run-OTHER", conversationId: "conv-OTHER", callId: "toolu-2" } },
    });
    expect(calls[0]).toMatchObject({ identity: { runId: "run-1", conversationId: "" } });
  });

  test("a wire identity naming another run rejects before the service", async () => {
    const { service, calls } = stubService();
    const result = await createProductToolsDispatch({ service }).call({
      caller,
      name: "history_recent",
      args: {},
      metaIdentity: { runId: "run-OTHER" },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("does not match");
    expect(calls).toHaveLength(0);
  });

  test("a service failure comes back as an error result, not a rejection", async () => {
    const { service } = stubService(new Error("artifact storage full"));
    const result = await createProductToolsDispatch({ service }).call({
      caller,
      name: "artifact_upload",
      args: {},
    });
    expect(result).toEqual({ content: "artifact storage full", isError: true });
  });
});

describe("ADR 0059 upward frames", () => {
  test("a terminal result names the worker and its status", () => {
    const ok = frameResultInput("fe", "completed", "改了三个文件");
    expect(ok).toContain("fe");
    expect(ok).toContain("改了三个文件");
    const failed = frameResultInput("fe", "failed", "");
    expect(failed).toContain("failed");
    expect(failed).toContain("没有产出文字结果");
  });

  test("a runaway transcript is clamped — it is a notification, not a forward", () => {
    const framed = frameResultInput("fe", "completed", "x".repeat(5000));
    expect(framed.length).toBeLessThan(2200);
    expect(framed).toContain("…");
  });

  test("report framing carries the purpose", () => {
    expect(frameReportInput("fe", "attention", "要我删库吗")).toContain("需要你的判断");
    expect(frameReportInput("fe", "progress", "跑了两个文件")).toContain("进度");
  });
});

describe("ADR 0060 verification verdicts", () => {
  test("the four states are distinct and none is silent", () => {
    const passed = verificationLine("passed");
    const failed = verificationLine("failed");
    const notRun = verificationLine("not_run");
    const notConfigured = verificationLine("not_configured");
    const absent = verificationLine(undefined);
    const all = [passed, failed, notRun, notConfigured, absent];
    expect(new Set(all).size).toBe(5);
    // Absence is spelled out, never blank and never a pass.
    expect(absent).toContain("未提供");
    expect(absent).not.toContain("通过");
  });

  test("only a pass lets the dispatcher announce completion", () => {
    const passed = frameReportInput("fe", "answer", "改好了", "passed");
    expect(passed).not.toContain("不得说");
    for (const verdict of ["failed", "not_run", "not_configured", undefined] as const) {
      const framed = frameReportInput("fe", "answer", "改好了", verdict);
      expect(framed).toContain("不得说");
    }
  });

  test("a terminal notice without a report says so", () => {
    expect(frameResultInput("fe", "completed", "改了三个文件")).toContain("未提供验收证据");
  });
});

describe("Batch 2: single-source schemas, role scoping, and envelope fixes", () => {
  test("no product tool exposes the dead identity schema argument", () => {
    for (const tool of PRODUCT_TOOLS) {
      const props = (tool.inputSchema.properties as Record<string, unknown> | undefined) ?? {};
      expect(props.identity).toBeUndefined();
    }
    const reqTrack = PRODUCT_TOOLS.find((t) => t.name === "requirement_track");
    expect(reqTrack?.inputSchema.required).toBeUndefined();
    const dispatchTool = PRODUCT_TOOLS.find((t) => t.name === "dispatch");
    expect(
      (dispatchTool?.inputSchema.properties as Record<string, unknown> | undefined)?.requirement,
    ).toBeDefined();
    const rememberTool = PRODUCT_TOOLS.find((t) => t.name === "remember");
    expect(rememberTool?.description).toContain("personal/<agentId>/memories.md");
    expect(rememberTool?.description).not.toContain(".oma/memory/product.md");
  });

  test("role scoping strips front-only tools from workers and worker-only tools from front desk", () => {
    const workerNames = new Set(toolsForRole("worker").map((t) => t.name));
    expect(workerNames.has("dispatch")).toBe(false);
    expect(workerNames.has("remember")).toBe(false);
    expect(workerNames.has("workflow_run")).toBe(false);
    expect(workerNames.has("handback")).toBe(true);
    expect(workerNames.has("project_push")).toBe(true);

    const frontNames = new Set(toolsForRole("front").map((t) => t.name));
    expect(frontNames.has("dispatch")).toBe(true);
    expect(frontNames.has("handback")).toBe(false);
    expect(frontNames.has("report")).toBe(false);
    expect(frontNames.has("project_push")).toBe(false);

    const { service } = stubService();
    const scoped = createProductToolsDispatch({
      service,
      roleOf: (id) => (id === "coder" ? "worker" : "front"),
    });
    expect(
      scoped.listTools({ runId: "r1", agentId: "coder" }).tools.some((t) => t.name === "dispatch"),
    ).toBe(false);
    expect(
      scoped
        .listTools({ runId: "r2", agentId: "default" })
        .tools.some((t) => t.name === "handback"),
    ).toBe(false);
  });

  test("frameHandbackInput does not contradict front-desk invariant; frameResultInput orders artifacts before plan and handles failures", () => {
    const handback = frameHandbackInput("coder", "missing db creds");
    expect(handback).not.toContain("自己做");

    const ok = frameResultInput(
      "coder",
      "completed",
      "done",
      ["artifacts://r/out.md"],
      "- [pending] next",
      "passed",
    );
    expect(ok.indexOf("<artifacts>")).toBeLessThan(ok.indexOf("<plan>"));
    expect(ok).toContain("验收：指定检查已通过");
    expect(ok).not.toContain("没有验收证据时不得说");

    const failed = frameResultInput("coder", "failed", "boom", [], "- [pending] next");
    expect(failed).not.toContain("直接派下一步");
    expect(failed).toContain("这一步未成功");

    const attention = frameReportInput("coder", "attention", "need env choice");
    expect(attention).not.toContain("未提供验收证据");
  });
});
