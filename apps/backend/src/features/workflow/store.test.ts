import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowDefinition } from "@chengchenccc/workflow";
import { classifyWorkflowRisk, createFsWorkflowStore, resolveConcurrencyPolicy } from "./store.js";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "wf-store-"));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const baseDef = (overrides?: Partial<WorkflowDefinition>): WorkflowDefinition => ({
  version: 1,
  id: "deploy-sop",
  meta: { name: "Deploy SOP" },
  nodes: [
    { id: "start", type: "start" },
    { id: "build", type: "agent", agentId: "coder", prompt: "Build v1" },
    { id: "done", type: "end", status: "success" },
  ],
  edges: [
    { from: "start", to: "build" },
    { from: "build", to: "done" },
  ],
  ...overrides,
});

describe("classifyWorkflowRisk (ADR 0084 D2)", () => {
  test("pure declarative SOP requires no approval", () => {
    const risk = classifyWorkflowRisk(null, baseDef());
    expect(risk.requiresApproval).toBe(false);
    expect(risk.reasons).toEqual([]);
  });

  test("added or modified script node requires script approval; unchanged script does not", () => {
    const withScript = baseDef({
      nodes: [
        { id: "start", type: "start" },
        { id: "calc", type: "script", code: "return { ok: true }" },
        { id: "build", type: "agent", agentId: "coder", prompt: "v1" },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "calc" },
        { from: "calc", to: "build" },
        { from: "build", to: "done" },
      ],
    });
    const added = classifyWorkflowRisk(baseDef(), withScript);
    expect(added.requiresApproval).toBe(true);
    expect(added.reasons).toEqual(["script"]);
    expect(added.scriptNodes).toHaveLength(1);

    // Changing only agent prompt while script code stays identical -> no approval required!
    const promptEdited: WorkflowDefinition = {
      ...withScript,
      nodes: withScript.nodes.map((n) =>
        n.id === "build" && n.type === "agent" ? { ...n, prompt: "v2" } : n,
      ),
    };
    expect(classifyWorkflowRisk(withScript, promptEdited).requiresApproval).toBe(false);

    // Changing script code -> requires approval again.
    const scriptEdited: WorkflowDefinition = {
      ...withScript,
      nodes: withScript.nodes.map((n) =>
        n.id === "calc" && n.type === "script" ? { ...n, code: "return { ok: false }" } : n,
      ),
    };
    expect(classifyWorkflowRisk(withScript, scriptEdited).reasons).toEqual(["script"]);
  });

  test("enabled cron trigger requires cron approval; disabled or unchanged cron does not", () => {
    const disabledCron = baseDef({
      triggers: [{ type: "cron", cron: "0 9 * * *", enabled: false }],
    });
    expect(classifyWorkflowRisk(null, disabledCron).requiresApproval).toBe(false);

    const enabledCron = baseDef({
      triggers: [{ type: "cron", cron: "0 9 * * *", enabled: true }],
    });
    const r = classifyWorkflowRisk(disabledCron, enabledCron);
    expect(r.requiresApproval).toBe(true);
    expect(r.reasons).toEqual(["cron"]);
    expect(r.cronTriggers).toEqual([{ cron: "0 9 * * *" }]);

    // Unchanged enabled cron on a later prompt edit -> no approval required.
    expect(classifyWorkflowRisk(enabledCron, enabledCron).requiresApproval).toBe(false);
  });
});

describe("resolveConcurrencyPolicy (ADR 0084 D7)", () => {
  test("defaults to per_requirement for SOPs, forbid for enabled cron, honors explicit policy", () => {
    expect(resolveConcurrencyPolicy(baseDef())).toBe("per_requirement");
    expect(
      resolveConcurrencyPolicy(
        baseDef({ triggers: [{ type: "cron", cron: "0 4 * * *", enabled: true }] }),
      ),
    ).toBe("forbid");
    expect(
      resolveConcurrencyPolicy(
        baseDef({
          triggers: [{ type: "cron", cron: "0 4 * * *", enabled: true }],
          concurrencyPolicy: "allow",
        }),
      ),
    ).toBe("allow");
  });
});

describe("createFsWorkflowStore (ADR 0084 D1 git history & revert)", () => {
  test("commits writes with author attribution, tracks history, reverts, and removes", () => {
    const dir = makeTempDir();
    const store = createFsWorkflowStore(dir);
    expect(store.gitReady).toBe(true);

    const v1 = baseDef();
    const c1 = store.write("deploy-sop", v1, {
      author: "agent:default",
      summary: "create deploy-sop",
    });
    expect(c1).toBeTruthy();
    expect(store.listIds()).toEqual(["deploy-sop"]);

    const v2 = baseDef({
      nodes: [
        { id: "start", type: "start" },
        { id: "build", type: "agent", agentId: "coder", prompt: "Build v2" },
        { id: "done", type: "end", status: "success" },
      ],
    });
    const c2 = store.write("deploy-sop", v2, {
      author: "user",
      summary: "update deploy-sop prompt",
    });
    expect(c2).toBeTruthy();
    expect(c2).not.toBe(c1);

    const hist = store.history("deploy-sop");
    expect(hist.length).toBeGreaterThanOrEqual(2);
    expect(hist[0]?.author).toBe("user");
    expect(hist[1]?.author).toBe("agent:default");

    // Revert back to v1 commit.
    const reverted = store.revert("deploy-sop", hist[1]!.commit, {
      author: "user",
      summary: "revert deploy-sop to v1",
    });
    const buildNode = reverted.definition.nodes.find((n) => n.id === "build");
    expect(buildNode?.type === "agent" ? buildNode.prompt : "").toBe("Build v1");
    expect(store.history("deploy-sop").length).toBeGreaterThanOrEqual(3);

    expect(store.remove("deploy-sop", { author: "agent:default", summary: "delete" })).toBe(true);
    expect(store.exists("deploy-sop")).toBe(false);
    expect(store.remove("deploy-sop", { author: "agent:default", summary: "delete" })).toBe(false);
  });

  test("rejects path traversal in workflowId", () => {
    const store = createFsWorkflowStore(makeTempDir());
    expect(() => store.readRaw("../secret")).toThrow(/invalid workflow id/);
    expect(() => store.write("../escape", baseDef(), { author: "user", summary: "bad" })).toThrow(
      /invalid workflow id/,
    );
  });
});
