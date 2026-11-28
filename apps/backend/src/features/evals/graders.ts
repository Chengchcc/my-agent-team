import type { EvalCase, GraderOutcome, GraderSpec } from "./domain.js";

export interface ToolInvocationFact {
  readonly toolName: string;
  readonly inputText: string;
  readonly isError: boolean;
}

export interface WorkflowExecutionFact {
  readonly status: string;
  readonly exit: string | null;
  readonly visitedNodes: readonly string[];
  readonly budgetExhausted: boolean;
}

export interface TrialObservation {
  readonly input: string | Record<string, unknown>;
  readonly outputText: string;
  readonly status: string;
  readonly error: string | null;
  readonly activeDurationMs: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly costUsd: number;
  readonly skillsActivated: readonly string[];
  readonly tools: readonly ToolInvocationFact[];
  readonly workflow?: WorkflowExecutionFact;
  readonly workDir?: string;
}

export interface GraderRuntimeDeps {
  readonly runCommand?: (input: {
    command: string;
    cwd: string;
    timeoutMs: number;
  }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readonly judge?: (input: {
    rubric: string;
    input: string | Record<string, unknown>;
    outputText: string;
    modelId?: string;
  }) => Promise<{ pass: boolean; score: number; reason: string }>;
}

function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function runSingleGrader(
  spec: GraderSpec,
  obs: TrialObservation,
  deps: GraderRuntimeDeps,
): Promise<GraderOutcome> {
  switch (spec.type) {
    case "skill_activated": {
      const hit = obs.skillsActivated.includes(spec.skillName);
      const passed = spec.expected ? hit : !hit;
      return {
        type: spec.type,
        label: `skill:${spec.skillName}`,
        passed,
        score: passed ? 1 : 0,
        reason: passed
          ? spec.expected
            ? `Skill "${spec.skillName}" was activated`
            : `Skill "${spec.skillName}" was not activated (as expected)`
          : spec.expected
            ? `Expected skill "${spec.skillName}" to activate, got [${obs.skillsActivated.join(", ") || "none"}]`
            : `Skill "${spec.skillName}" was activated unexpectedly`,
      };
    }

    case "tool_called": {
      const matches = obs.tools.filter((t) => {
        if (t.toolName !== spec.toolName) return false;
        if (spec.argsMatch && !t.inputText.includes(spec.argsMatch)) return false;
        return true;
      });
      const passed = matches.length >= spec.minCalls;
      return {
        type: spec.type,
        label: `tool:${spec.toolName}`,
        passed,
        score: passed ? 1 : 0,
        reason: passed
          ? `Tool "${spec.toolName}" called ${matches.length} time(s)`
          : `Expected "${spec.toolName}" >= ${spec.minCalls} call(s)${spec.argsMatch ? ` matching "${spec.argsMatch}"` : ""}, got ${matches.length}`,
      };
    }

    case "tool_forbidden": {
      const hits = obs.tools.filter((t) => t.toolName === spec.toolName);
      const passed = hits.length === 0;
      return {
        type: spec.type,
        label: `forbid:${spec.toolName}`,
        passed,
        score: passed ? 1 : 0,
        reason: passed
          ? `Forbidden tool "${spec.toolName}" was not called`
          : `Forbidden tool "${spec.toolName}" was called ${hits.length} time(s)`,
      };
    }

    case "workflow_outcome": {
      const wf = obs.workflow;
      if (!wf) {
        return {
          type: spec.type,
          label: "workflow_outcome",
          passed: false,
          score: 0,
          reason: "No workflow execution facts recorded for this trial",
        };
      }
      const failures: string[] = [];
      if (spec.expectedStatus && wf.status !== spec.expectedStatus) {
        failures.push(`status=${wf.status} (expected ${spec.expectedStatus})`);
      }
      if (spec.expectedExit !== undefined && wf.exit !== spec.expectedExit) {
        failures.push(`exit=${wf.exit ?? "null"} (expected ${spec.expectedExit})`);
      }
      for (const reqNode of spec.requiredNodes ?? []) {
        if (!wf.visitedNodes.includes(reqNode)) {
          failures.push(`missing required node "${reqNode}"`);
        }
      }
      for (const forbNode of spec.forbiddenNodes ?? []) {
        if (wf.visitedNodes.includes(forbNode)) {
          failures.push(`visited forbidden node "${forbNode}"`);
        }
      }
      if (spec.forbidBudgetExhausted && wf.budgetExhausted) {
        failures.push("workflow hit budget_exhausted");
      }
      const passed = failures.length === 0;
      return {
        type: spec.type,
        label: "workflow_outcome",
        passed,
        score: passed ? 1 : 0,
        reason: passed
          ? `Workflow ${wf.status}${wf.exit ? ` (${wf.exit})` : ""} via [${wf.visitedNodes.join(" -> ")}]`
          : failures.join("; "),
      };
    }

    case "output_match": {
      const failures: string[] = [];
      for (const needle of spec.contains ?? []) {
        if (!obs.outputText.includes(needle)) failures.push(`missing "${needle}"`);
      }
      for (const banned of spec.notContains ?? []) {
        if (obs.outputText.includes(banned)) failures.push(`unexpected "${banned}"`);
      }
      if (spec.regex) {
        try {
          if (!new RegExp(spec.regex, "m").test(obs.outputText)) {
            failures.push(`regex /${spec.regex}/ did not match`);
          }
        } catch (err) {
          failures.push(`invalid regex: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (spec.jsonEquals && Object.keys(spec.jsonEquals).length > 0) {
        const parsed = extractFirstJsonObject(obs.outputText);
        if (!parsed) {
          failures.push("output did not contain a parseable JSON object");
        } else {
          for (const [key, expected] of Object.entries(spec.jsonEquals)) {
            if (JSON.stringify(parsed[key]) !== JSON.stringify(expected)) {
              failures.push(
                `${key}=${JSON.stringify(parsed[key])} (expected ${JSON.stringify(expected)})`,
              );
            }
          }
        }
      }
      const passed = failures.length === 0;
      return {
        type: spec.type,
        label: "output_match",
        passed,
        score: passed ? 1 : 0,
        reason: passed ? "Output satisfied all match assertions" : failures.join("; "),
      };
    }

    case "command_check": {
      if (!deps.runCommand || !obs.workDir) {
        return {
          type: spec.type,
          label: `cmd:${spec.command.slice(0, 32)}`,
          passed: false,
          score: 0,
          reason: "command_check requires an isolated workspace fixture and command runner",
        };
      }
      const res = await deps.runCommand({
        command: spec.command,
        cwd: obs.workDir,
        timeoutMs: spec.timeoutMs,
      });
      const passed = res.exitCode === 0;
      return {
        type: spec.type,
        label: `cmd:${spec.command.slice(0, 32)}`,
        passed,
        score: passed ? 1 : 0,
        reason: passed
          ? `Command exited 0`
          : `Exit ${res.exitCode}: ${(res.stderr || res.stdout).slice(0, 200)}`,
      };
    }

    case "llm_judge": {
      if (!deps.judge) {
        return {
          type: spec.type,
          label: "llm_judge",
          passed: false,
          score: 0,
          reason: "No LLM judge model is configured on this backend",
        };
      }
      const verdict = await deps.judge({
        rubric: spec.rubric,
        input: obs.input,
        outputText: obs.outputText,
        modelId: spec.modelId,
      });
      const normalizedScore = Math.max(0, Math.min(1, verdict.score / 5));
      const passed = verdict.pass && verdict.score >= spec.minScore;
      return {
        type: spec.type,
        label: "llm_judge",
        passed,
        score: normalizedScore,
        reason: `${verdict.score}/5 — ${verdict.reason}`,
      };
    }
  }
}

/** ADR 0085 D5: Evaluate all 3 layers (Layer 1 deterministic contracts,
 *  Layer 2 trajectory & budget guards, Layer 3 optional LLM judge). */
export async function gradeEvalTrial(
  evalCase: EvalCase,
  obs: TrialObservation,
  deps: GraderRuntimeDeps = {},
): Promise<{ passed: boolean; score: number; graderResults: GraderOutcome[] }> {
  const graderResults: GraderOutcome[] = [];

  // Layer 1 & Layer 3: case-declared graders
  for (const spec of evalCase.graders) {
    graderResults.push(await runSingleGrader(spec, obs, deps));
  }

  // Layer 2: automatic trajectory & budget guards
  const b = evalCase.budget;
  if (b?.maxDurationMs !== undefined) {
    const ok = obs.activeDurationMs <= b.maxDurationMs;
    graderResults.push({
      type: "budget_duration",
      label: `duration<=${b.maxDurationMs}ms`,
      passed: ok,
      score: ok ? 1 : 0,
      reason: ok
        ? `Active duration ${obs.activeDurationMs}ms within ${b.maxDurationMs}ms`
        : `Active duration ${obs.activeDurationMs}ms exceeded ${b.maxDurationMs}ms`,
    });
  }
  if (b?.maxToolCalls !== undefined) {
    const ok = obs.toolCalls <= b.maxToolCalls;
    graderResults.push({
      type: "budget_tools",
      label: `tools<=${b.maxToolCalls}`,
      passed: ok,
      score: ok ? 1 : 0,
      reason: ok
        ? `${obs.toolCalls} tool call(s) within cap ${b.maxToolCalls}`
        : `${obs.toolCalls} tool call(s) exceeded cap ${b.maxToolCalls}`,
    });
  }
  if (b?.maxCostUsd !== undefined) {
    const ok = obs.costUsd <= b.maxCostUsd;
    graderResults.push({
      type: "budget_cost",
      label: `cost<=$${b.maxCostUsd}`,
      passed: ok,
      score: ok ? 1 : 0,
      reason: ok
        ? `Cost $${obs.costUsd.toFixed(4)} within $${b.maxCostUsd}`
        : `Cost $${obs.costUsd.toFixed(4)} exceeded $${b.maxCostUsd}`,
    });
  }

  const spinning = obs.toolCalls >= 8 && obs.activeDurationMs >= 60_000 && obs.outputTokens <= 20;
  if (spinning) {
    graderResults.push({
      type: "anti_spinning",
      label: "no_spinning",
      passed: false,
      score: 0,
      reason: `Spinning detected: ${obs.toolCalls} tool calls in ${obs.activeDurationMs}ms with ${obs.outputTokens} output tokens`,
    });
  }

  const passed = graderResults.length > 0 && graderResults.every((g) => g.passed);
  const score =
    graderResults.length > 0
      ? graderResults.reduce((sum, g) => sum + g.score, 0) / graderResults.length
      : 0;
  return { passed, score, graderResults };
}
