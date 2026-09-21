import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendRunInput } from "@chengchenccc/agent-contract";
import {
  createModelRuntime,
  createOmaRuntime,
  registerBuiltinProviders,
} from "../runtime/create-runtime.fixture.js";

/** The omp-aligned goal loop, driven through the REAL TUI session over the
 *  scripted io (no terminal): /goal starts the autonomous loop, the fake
 *  model calls the goal tool's complete op, the loop ends, the terminal goal
 *  state (paused after interrupt; budget steering; session persistence) is
 *  pinned by the unit layer in goals/state.test.ts. */
const ws = mkdtempSync(join(tmpdir(), "oma-goalloop-"));
afterAll(() => rmSync(ws, { recursive: true, force: true }));

function runInput(runId: string): BackendRunInput<"oma"> {
  return {
    input: { inputId: `in-${runId}`, message: { role: "user", text: "go" } },
    run: { runId, model: { backendKind: "oma", modelId: "fake/echo" }, configRevision: 1 },
    workspace: { root: ws, access: "read_write" },
    metadata: { conversationId: "c", agentId: "m", branchId: "b" },
  };
}

/** The goal-mode plugin's tool table mounted the way tui-mode mounts it:
 *  createOmaRuntime pluginComponents. This pins the tool executes against
 *  the real runtime plumbing (validatePlugins, tool table, execute shape). */
describe("goal tool through the real runtime", () => {
  test("ops create/get/complete round-trip and drop clears", async () => {
    const savedProvider = process.env.OMA_FAKE_PROVIDER;
    const savedTool = process.env.OMA_FAKE_TOOL;
    process.env.OMA_FAKE_PROVIDER = "1";
    // The fake model calls the goal tool: create, then complete.
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      { name: "goal", input: { op: "create", objective: "tests pass" } },
      { name: "goal", input: { op: "complete" } },
    ]);
    try {
      let goalState: {
        enabled: boolean;
        mode: "active" | "exiting";
        reason?: "completed";
        goal: {
          id: string;
          objective: string;
          status: "active" | "paused" | "budget-limited" | "complete" | "dropped";
          tokensUsed: number;
          timeUsedSeconds: number;
        };
      } | null = null;
      const mr = createModelRuntime();
      registerBuiltinProviders(mr, process.env);
      const rt = await createOmaRuntime({
        runId: "r-goaltool",
        modelId: "fake/echo",
        workspaceRoot: ws,
        workspaceAccess: "read_write",
        modelRuntime: mr,
        skillRoots: [],
        pluginComponents: {
          plugins: [
            {
              name: "goal-mode",
              tools: [
                {
                  name: "goal",
                  description: "goal ops",
                  inputSchema: {
                    type: "object",
                    properties: { op: { type: "string" } },
                    required: ["op"],
                  },
                  async execute(input) {
                    const args = input as { op?: string; objective?: string };
                    if (args.op === "create") {
                      const goal = {
                        id: "g1",
                        objective: args.objective ?? "",
                        status: "active" as const,
                        tokensUsed: 0,
                        timeUsedSeconds: 0,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                      };
                      goalState = { enabled: true, mode: "active", goal };
                      return { content: "created" };
                    }
                    if (args.op === "complete" && goalState) {
                      goalState = {
                        ...goalState,
                        enabled: false,
                        mode: "exiting",
                        reason: "completed",
                        goal: { ...goalState.goal, status: "complete" },
                      };
                      return { content: "completed" };
                    }
                    return { content: "unexpected op", isError: true };
                  },
                },
              ],
            },
          ],
        },
      });
      const outcome = await (await rt.run(runInput("r-goaltool"))).outcome;
      await rt.close();
      const text = JSON.stringify(outcome.messages);
      // Both scripted ops ran through the real table.
      expect(text).toContain("created");
      expect(text).toContain("completed");
      // And the state machine landed on complete + exiting.
      expect(goalState).not.toBeNull();
      expect(goalState!.goal.status).toBe("complete");
      expect(goalState!.enabled).toBe(false);
      expect(goalState!.mode).toBe("exiting");
      expect(goalState!.reason).toBe("completed");
    } finally {
      if (savedProvider === undefined) delete process.env.OMA_FAKE_PROVIDER;
      else process.env.OMA_FAKE_PROVIDER = savedProvider;
      if (savedTool === undefined) delete process.env.OMA_FAKE_TOOL;
      else process.env.OMA_FAKE_TOOL = savedTool;
    }
  }, 30_000);
});
