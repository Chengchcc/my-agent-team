import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
let proposals: Array<{ kind: string; targetId: string; payload: unknown }>;

/** What a tool hands the proposal store: recorded here, read back by the assertions. */
function recorder() {
  return {
    propose: (kind: string, targetId: string, payload: unknown) => {
      proposals.push({ kind, targetId, payload });
    },
  };
}
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-mcp-"));
  file = join(dir, "wf.workflow.json");
  writeFileSync(file, JSON.stringify(def, null, 2));
  proposals = [];
});

afterEach(() => {
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
    const patched = { ...def, meta: { name: "patched", status: "draft" } };
    const text = callWorkflowTool({ workflowDir: dir, proposals: recorder() }, "workflow_write", {
      workflowId: "wf",
      definition: patched,
    });
    expect(text).toContain("NOT saved");
    // The proposal is a row the editor reads, so it is the record of what was asked for.
    expect(proposals).toEqual([{ kind: "workflow_definition", targetId: "wf", payload: patched }]);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("workflow_write rejects a definition the editor could never save", () => {
    expect(() =>
      callWorkflowTool({ workflowDir: dir, proposals: recorder() }, "workflow_write", {
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
