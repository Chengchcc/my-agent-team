import { describe, expect, test } from "bun:test";
import { renderWorkflowCard, workflowCardModel } from "./workflow-card.js";

describe("workflow card model", () => {
  test("statuses map to templates and verdicts, nodes to marks", () => {
    const m = workflowCardModel({
      workflowId: "wf-a",
      status: "running",
      nodes: [
        { nodeId: "scan", status: "completed" },
        { nodeId: "report", status: "running" },
        { nodeId: "ask", status: "waiting_human" },
        { nodeId: "gone", status: "failed" },
        { nodeId: "later", status: "pending" },
      ],
    });
    expect(m.template).toBe("blue");
    expect(m.nodesMd).toContain("✅ scan");
    expect(m.nodesMd).toContain("▶️ report");
    expect(m.nodesMd).toContain("❓ ask");
    expect(m.nodesMd).toContain("❌ gone");
    expect(m.nodesMd).toContain("▫️ later");
    expect(m.verdictMd).toContain("跑着");
    expect(workflowCardModel({ workflowId: "w", status: "success", nodes: [] }).template).toBe(
      "green",
    );
    expect(
      workflowCardModel({ workflowId: "w", status: "failure", nodes: [] }).verdictMd,
    ).toContain("失败");
    expect(workflowCardModel({ workflowId: "w", status: "weird", nodes: [] }).template).toBe(
      "grey",
    );
  });

  test("the rendered card keeps stable element ids and freezes when terminal", () => {
    const live = renderWorkflowCard({ workflowId: "wf-a", status: "running", nodes: [] });
    expect(live.config).toMatchObject({ streaming_mode: true, update_multi: true });
    const term = renderWorkflowCard({
      workflowId: "wf-a",
      status: "success",
      nodes: [],
      outputSummary: "输出：{}",
    });
    expect((term.config as Record<string, unknown>).streaming_mode).toBeUndefined();
    expect(JSON.stringify(term)).toContain("wf_nodes");
    expect(JSON.stringify(term)).toContain("wf_verdict");
    expect(JSON.stringify(term)).toContain("输出：{}");
  });
});

describe("workflow card human buttons", () => {
  test("a waiting card carries approve/deny wired to the execution", () => {
    const card = renderWorkflowCard({
      workflowId: "wf-a",
      status: "waiting_human",
      nodes: [{ nodeId: "ask", status: "waiting_human" }],
      executionId: "e_1",
      waitingNodeId: "ask",
    });
    const elements = JSON.stringify(card);
    expect(elements).toContain("wf_approve");
    expect(elements).toContain("wf_deny");
    expect(elements).toContain("workflow_human");
    expect(elements).toContain("e_1");
    // Running cards never carry the buttons.
    expect(
      JSON.stringify(renderWorkflowCard({ workflowId: "wf-a", status: "running", nodes: [] })),
    ).not.toContain("wf_approve");
  });
});
