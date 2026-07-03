import type { ChatModel, Tool } from "@my-agent-team/core";
import { collectStream } from "@my-agent-team/core";
import type { Plugin, StopDecision } from "@my-agent-team/framework";
import { extractText, type Message } from "@my-agent-team/message";

// ─── Types ───

export type TodoStatus = "pending" | "in_progress" | "done";

export interface Todo {
  step: string;
  status: TodoStatus;
}

export type StopValidator = (
  messages: readonly Message[],
) => StopDecision | undefined | Promise<StopDecision | undefined>;

export interface TaskGuardOptions {
  /** Model for plan generation. Injected by harness via closure — never from HookContext. */
  model: ChatModel;
  /** Seed a todo plan on beforeRun. Default true. */
  plan?: boolean;
  /** Inject todo progress into system prompt each turn. Default true. */
  showProgress?: boolean;
  /** Extra deterministic stop validators (unresolvedToolErrors is always included). */
  extraValidators?: StopValidator[];
}

// ─── Helpers ───

function renderTodo(list: readonly Todo[]): string {
  if (list.length === 0) return "(empty plan)";
  return list
    .map((t) => {
      const mark = t.status === "done" ? "x" : t.status === "in_progress" ? ">" : " ";
      return `- [${mark}] ${t.step}`;
    })
    .join("\n");
}

function injectIntoSystem(messages: readonly Message[], block: string): Message[] {
  const systemIdx = messages.findIndex((m) => m.role === "system");
  if (systemIdx < 0) return [...messages];
  const sys = messages[systemIdx]!;
  const newSys = {
    ...sys,
    text: `${sys.text ?? ""}\n\n${block}`,
  };
  return [...messages.slice(0, systemIdx), newSys, ...messages.slice(systemIdx + 1)];
}

// ─── Deterministic validators ───

/**
 * Find the last user message with tool_result blocks.
 * If any tool_result has is_error=true without a subsequent attempt to retry,
 * signal force-continue so the model must address the error first.
 */
export function unresolvedToolErrors(messages: readonly Message[]): StopDecision | undefined {
  // Walk backwards to find the last user message that contains tool_results
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "user" || !msg.blocks) continue;
    const results = msg.blocks.filter((b) => "tool_use_id" in b);
    if (results.length === 0) continue;

    // If the very last tool_result-bearing message has errors, and no
    // subsequent assistant message addressed them, that's an early stop.
    const hasError = results.some((b) => "is_error" in b && (b as { is_error?: boolean }).is_error);
    if (hasError) {
      return {
        continue: true,
        reason:
          "At least one tool returned an error. Please address the error before stopping. " +
          "You can try an alternative approach, fix the input and retry, or explain why the error is not blocking.",
      };
    }
    // Found the last tool_result message — stop looking
    break;
  }
  return undefined;
}

// ─── Plan generation ───

async function generatePlan(model: ChatModel, messages: readonly Message[]): Promise<string[]> {
  const planPrompt = [
    "You are about to work on a task. Before you start, break it down into",
    "an ordered list of steps. Each step should be a concrete, verifiable action",
    "that represents roughly 1-3 tool calls or a meaningful unit of progress.",
    "",
    "Rules:",
    "- If the task is trivial (e.g. 'what is 2+2'), return an empty list.",
    "- Keep steps concise (one line each). Aim for 3-7 steps for a typical task.",
    "- Order matters: later steps that depend on earlier ones must come after.",
    "- Do NOT include meta-steps like 'verify', 'double-check', or 'review' — the",
    "  framework handles verification separately.",
    "- Only plan steps the available tools can execute. If unsure, keep the step",
    "  high-level (e.g. 'Fix the bug' rather than 'Open file X at line Y').",
    "",
    "Reply with ONLY a JSON array of strings. No markdown, no explanation.",
    'Example: ["Read the config file", "Update the port value", "Restart the service"]',
  ].join("\n");

  // Only pass system + last user message to avoid token bloat and
  // prevent old <todo> injection blocks from polluting plan context.
  const systemMsg = messages.find((m) => m.role === "system");
  const lastUser = messages.findLast((m) => m.role === "user");
  const slim: Message[] = [
    ...(systemMsg ? [systemMsg] : []),
    ...(lastUser ? [lastUser] : []),
    { role: "user" as const, text: planPrompt },
  ];

  const result = await collectStream(model.stream(slim, { tools: [] as const }));
  const text = extractText({ blocks: result.blocks }).trim();

  // Try to extract JSON array from the response
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
      return parsed as string[];
    }
  } catch {
    // fall through
  }
  return [];
}

function planGuidance(steps: string[]): string {
  return [
    "A plan has been prepared for this task. Follow it as a guide,",
    "but adapt if reality forces a different path.",
    "",
    "Use the `todo_write` tool to track your progress:",
    "- Mark a step `in_progress` when you start working on it.",
    "- Mark it `done` when finished. Then move to the next.",
    "- Only ONE step in_progress at a time. Finish before starting the next.",
    "- The plan cannot be modified — only status can change.",
    "",
    "The framework monitors your progress. If you try to stop before",
    "all steps are done, you will be asked to continue.",
    "When all steps are done, give your final answer.",
    "",
    "Plan:",
    steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
  ].join("\n");
}

// ─── todo_write tool ───

function createTodoWriteTool(opts: {
  getTodos: (sessionId: string) => Todo[] | undefined;
  setTodos: (sessionId: string, todos: Todo[]) => void;
  getActiveSessionId: () => string;
  onUpdate: (todos: Todo[]) => void;
}): Tool {
  return {
    name: "todo_write",
    description:
      "Mark todo steps as in_progress or done. Cannot add or remove steps — only update status of existing steps.",
    inputSchema: {
      type: "object" as const,
      properties: {
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              step: { type: "string" },
              status: { type: "string", enum: ["in_progress", "done"] },
            },
            required: ["step", "status"],
          },
        },
      },
      required: ["updates"],
    },
    execute: (input: unknown) => {
      const { updates } = input as {
        updates: Array<{ step: string; status: "in_progress" | "done" }>;
      };
      const tid = opts.getActiveSessionId();
      const list = opts.getTodos(tid);
      if (!list) return { content: "no active todo list" };
      for (const u of updates) {
        const t = list.find((x) => x.step === u.step);
        if (t) t.status = u.status; // only update existing steps (freeze discipline)
      }
      // Emit snapshot for web UI
      opts.onUpdate([...list]);
      return { content: renderTodo(list) };
    },
  };
}

// ─── Plugin factory ───

/**
 * Task Guard plugin: plan → track → verify.
 *
 * - beforeRun: generates a todo list from the task and injects it as plan guidance.
 * - beforeModel: injects the current todo progress into the system prompt.
 * - beforeStop: deterministic hot-layer checks (unresolved errors + todo completion).
 * - todo_write tool: model flips step statuses as it works.
 *
 * The semantic cold-review round (verification) is NOT in this plugin —
 * it runs in the runner layer via agent.fork() + verificationGuidance().
 */
export function taskGuardPlugin(opts: TaskGuardOptions): Plugin {
  const todos = new Map<string, Todo[]>(); // sessionId → todo list
  const { model } = opts;
  const planEnabled = opts.plan !== false;
  const showProgress = opts.showProgress !== false;
  const extraValidators = opts.extraValidators ?? [];

  // Closure-bound state for todo_write tool (no ctx in Tool.execute)
  let activeSessionId = "";
  let onUpdate: (todos: Todo[]) => void = () => {};

  const todoWriteTool = createTodoWriteTool({
    getTodos: (sid) => todos.get(sid),
    setTodos: (sid, list) => todos.set(sid, list),
    getActiveSessionId: () => activeSessionId,
    onUpdate: (list) => onUpdate(list),
  });

  return {
    name: "task-guard",
    tools: [todoWriteTool],
    hooks: {
      async beforeRun(ctx, messages) {
        activeSessionId = ctx.sessionId;
        // Wire emit for todo_update events
        onUpdate = (list: Todo[]) => {
          ctx.emit?.({
            type: "todo_update",
            payload: { todos: list },
          });
        };

        if (!planEnabled) return [...messages];

        let steps: string[];
        try {
          steps = await generatePlan(model, messages);
        } catch {
          return [...messages]; // fail-open
        }
        if (steps.length === 0) return [...messages]; // trivial task

        const planList: Todo[] = steps.map((s) => ({
          step: s,
          status: "pending" as const,
        }));
        todos.set(ctx.sessionId, planList);

        // Emit initial snapshot
        onUpdate([...planList]);

        return [...messages, { role: "user" as const, text: planGuidance(steps) }];
      },

      async beforeModel(ctx, messages) {
        activeSessionId = ctx.sessionId;
        // Wire emit for todo_update events (re-wire on each hook fire in case ctx changed)
        onUpdate = (list: Todo[]) => {
          ctx.emit?.({
            type: "todo_update",
            payload: { todos: list },
          });
        };

        if (!showProgress) return [...messages];

        const list = todos.get(ctx.sessionId);
        if (!list?.length) return [...messages];

        const view = list
          .map((t) => {
            const mark = t.status === "done" ? "x" : t.status === "in_progress" ? ">" : " ";
            return `- [${mark}] ${t.step}`;
          })
          .join("\n");
        return injectIntoSystem(messages, `<todo>\n${view}\n</todo>`);
      },

      async beforeStop(ctx, messages) {
        // 1) Error gate: unresolved tool errors (deterministic)
        const errVerdict = unresolvedToolErrors(messages);
        if (errVerdict?.continue) return errVerdict;

        // Run extra validators (all deterministic/fail-open)
        for (const v of extraValidators) {
          try {
            const d = await v(messages);
            if (d?.continue) return d;
          } catch {
            // fail-open
          }
        }

        // 2) Todo gate: pending steps (deterministic).
        // Only uses the plan frozen by this run's beforeRun. No frozen plan
        // (e.g. resume, gate closed, or plan:false) → no opinion → pass through.
        const list = todos.get(ctx.sessionId);
        if (!list || list.length === 0) return undefined; // trivial task or no plan

        const left = list.filter((t) => t.status !== "done");
        if (left.length > 0) {
          return {
            continue: true,
            reason: [
              "The following todo steps are still pending. Complete them",
              "before stopping, or mark them done via todo_write if already satisfied:",
              "",
              left.map((t) => `- ${t.step}`).join("\n"),
            ].join("\n"),
          };
        }

        // All done deterministically — semantic review goes to cold-eval round
        return undefined;
      },
    },
  };
}
