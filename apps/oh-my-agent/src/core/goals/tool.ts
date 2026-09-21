import type { Plugin, PluginTool } from "../runtime/plugin.js";
import type { GoalRuntime } from "./runtime.js";

/** The model-facing `goal` tool (omp goals/tools/goal-tool.ts port): five
 *  ops over the session's GoalRuntime. Mounted ONLY while goal mode is live
 *  (active goal or /guided-goal interview) — the tool table is per-run, so
 *  the session decides by including this plugin. */
export function createGoalTool(runtime: GoalRuntime): PluginTool {
  return {
    name: "goal",
    description:
      "Manage the session's persistent autonomous goal. op=create (objective, optional token_budget) starts goal mode; op=get reads state; op=complete declares VERIFIED completion (audit current repo state first — verification scope = claim scope; never redefine success as a smaller/easier/already-done subset; budget exhaustion is NOT completion); op=resume / op=drop manage lifecycle.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", description: "create | get | complete | resume | drop" },
        objective: { type: "string", description: "Goal objective (op=create)" },
        token_budget: {
          type: "number",
          description: "Positive integer token budget (op=create, optional)",
        },
      },
      required: ["op"],
    },
    async execute(input) {
      const args = input as { op?: string; objective?: string; token_budget?: number };
      try {
        switch (args.op) {
          case "create": {
            const created = runtime.create(args.objective ?? "", args.token_budget);
            return { content: JSON.stringify(toolResponse(runtime, created)) };
          }
          case "get": {
            if (!runtime.goal) return { content: "No active goal." };
            return { content: JSON.stringify(toolResponse(runtime)) };
          }
          case "complete": {
            if (!runtime.goal) return { content: "No active goal.", isError: true };
            runtime.complete();
            return {
              content:
                "Goal marked complete. The autonomous loop ends after this turn; report the achievement (and budget usage, if any) to the user in your final message.",
            };
          }
          case "resume": {
            if (!runtime.goal) return { content: "No active goal.", isError: true };
            runtime.resume();
            return { content: JSON.stringify(toolResponse(runtime)) };
          }
          case "drop": {
            if (!runtime.goal) return { content: "No active goal.", isError: true };
            runtime.drop();
            return { content: "Goal dropped. Stop goal-directed work." };
          }
          default:
            return { content: `Error: unknown op "${args.op ?? ""}"`, isError: true };
        }
      } catch (err) {
        return {
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

/** omp goal-tool.ts buildGoalToolResponse shape. */
function toolResponse(runtime: GoalRuntime, state = runtime.state): Record<string, unknown> {
  const goal = state?.goal;
  if (!goal) return { goal: null };
  return {
    goal: {
      id: goal.id,
      objective: goal.objective,
      status: goal.status,
      tokensUsed: goal.tokensUsed,
      tokenBudget: goal.tokenBudget ?? null,
      remainingTokens: runtime.remainingTokens(),
      timeUsedSeconds: goal.timeUsedSeconds,
    },
  };
}

/** The plugin wrapper the TUI mounts for a goal-mode run. */
export function createGoalPlugin(runtime: GoalRuntime): Plugin {
  return { name: "goal-mode", tools: [createGoalTool(runtime)] };
}
