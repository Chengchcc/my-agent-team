import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowDefinitionEventBus } from "./definition-events.js";
import { callWorkflowTool } from "./mcp.js";

/** The agent-facing path into <dataDir>/workflows. The file tools are
 *  sandboxed to the agent workspace, so these two MCP tools are the ONLY way
 *  a Run can read or change a definition — their semantics are load-bearing. */
const def = {
  version: 1,
  id: "wf",
  nodes: [
    { id: "start", type: "start" },
    { id: "done", type: "end", status: "success" },
  ],
  edges: [{ from: "start", to: "done" }],
};

let dir: string;
let events: WorkflowDefinitionEventBus;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-mcp-"));
  file = join(dir, "wf.workflow.json");
  writeFileSync(file, JSON.stringify(def, null, 2));
  events = new WorkflowDefinitionEventBus();
});

afterEach(() => {
  events.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("workflow MCP tools", () => {
  test("workflow_read returns the raw definition", () => {
    const text = callWorkflowTool({ workflowDir: dir }, "workflow_read", { workflowId: "wf" });
    expect(JSON.parse(text).id).toBe("wf");
  });

  test("workflow_read refuses a traversing id", () => {
    expect(() =>
      callWorkflowTool({ workflowDir: dir }, "workflow_read", { workflowId: "../secret" }),
    ).toThrow(/invalid workflow id/);
  });

  test("workflow_write proposes without touching the file (user saves)", async () => {
    const before = readFileSync(file, "utf8");
    const sub = events.subscribe("wf");
    const patched = { ...def, meta: { name: "patched", status: "draft" } };
    const text = callWorkflowTool(
      { workflowDir: dir, definitionEvents: events },
      "workflow_write",
      {
        workflowId: "wf",
        definition: patched,
      },
    );
    expect(text).toContain("NOT saved");
    // The editor adopts the change off the definition SSE — that event IS the
    // delivery mechanism, so it is part of the contract.
    const ev = await sub.stream[Symbol.asyncIterator]().next();
    expect(ev.value?.workflowId).toBe("wf");
    expect(ev.value?.data.trigger).toBe("mcp");
    expect(ev.value?.data.definition).toEqual(patched);
    sub.unsubscribe();
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("workflow_write rejects a definition the editor could never save", () => {
    expect(() =>
      callWorkflowTool({ workflowDir: dir, definitionEvents: events }, "workflow_write", {
        workflowId: "wf",
        definition: { ...def, nodes: [] },
      }),
    ).toThrow(/non-empty/);
    expect(readFileSync(file, "utf8")).toContain('"start"');
  });

  test("unknown tool is an error, not a silent success", () => {
    expect(() => callWorkflowTool({ workflowDir: dir }, "workflow_delete", {})).toThrow(
      /unknown tool/,
    );
  });
});
