import { readFileSync } from "node:fs";
import { join } from "node:path";
import basePrompt from "../../prompts/system/base.md" with { type: "text" };
import memoryPrompt from "../../prompts/system/memory.md" with { type: "text" };
import safetyPrompt from "../../prompts/system/safety.md" with { type: "text" };
/** oma's own prompt layer (mirrors omp's src/prompts layout): base
 *  identity + safety + memory discipline live here as md files; workspace
 *  files (AGENTS.md / SOUL.md / USER.md + knowledge index) remain the
 *  agent-specific layer and are appended when present. Explicit
 *  run-input systemPrompt (Loop scopes) still wins wholesale — callers
 *  bypass this builder. */
export function buildSystemPrompt(input: {
  workspacePrompt?: string;
  cwd: string;
  /** Pre-read memory summary (workspace memory/memory_summary.md). */
  memorySummary?: string;
}): string {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;

  const parts = [basePrompt.trim(), safetyPrompt.trim()];
  const memoryBlock = input.memorySummary?.trim()
    ? `${memoryPrompt.trim()}\n\n<memory_summary>\n${input.memorySummary.trim()}\n</memory_summary>`
    : memoryPrompt.trim();
  parts.push(memoryBlock);
  if (input.workspacePrompt?.trim()) {
    parts.push(`<workspace_context>\n${input.workspacePrompt.trim()}\n</workspace_context>`);
  }
  parts.push(`Current date: ${date}`, `Current working directory: ${input.cwd}`);
  return parts.join("\n\n");
}

/** Approximate token cap for the memory block injected into the system
 *  prompt (omp memories.summaryInjectionTokenLimit, ~4 chars/token). */
const MEMORY_INJECTION_CHARS = 5000;

/** Workspace memory block for prompt injection: the consolidated summary
 *  plus the tail of explicit lessons (learn tool). Absent when the agent
 *  has never written memories. */
export function readMemorySummary(cwd: string): string | undefined {
  const memDir = join(cwd, ".oma", "memory");
  let summary = "";
  let learned = "";
  try {
    summary = readFileSync(join(memDir, "memory_summary.md"), "utf-8").trim();
  } catch {
    /* no summary yet */
  }
  try {
    const lines = readFileSync(join(memDir, "learned.md"), "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    learned = lines.slice(0, 40).join("\n").trim();
  } catch {
    /* no lessons yet */
  }
  const merged = [summary, learned ? `## Learned lessons\n${learned}` : ""]
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (!merged) return undefined;
  return merged.length > MEMORY_INJECTION_CHARS
    ? `${merged.slice(0, MEMORY_INJECTION_CHARS)}\n…[memory truncated]`
    : merged;
}
