import { readFileSync } from "node:fs";
import { join } from "node:path";
import basePrompt from "../../prompts/system/base.md" with { type: "text" };
import memoryPrompt from "../../prompts/system/memory.md" with { type: "text" };
import safetyPrompt from "../../prompts/system/safety.md" with { type: "text" };
/** oma's own prompt layer (mirrors omp's src/prompts layout): capability-gated
 *  base identity + safety + optional local-memory discipline live here as md
 *  files; host-supplied system prompts (product backend SOUL/USER, front-desk
 *  discipline, product context, recall) and workspace files (AGENTS.md /
 *  SOUL.md / USER.md + knowledge index) are appended when present. */
export function buildSystemPrompt(input: {
  workspacePrompt?: string;
  /** Authoritative host/product system prompt (e.g., backend-assembled SOUL,
   *  front-desk discipline, current tasks, and recall). */
  hostPrompt?: string;
  cwd: string;
  /** Pre-read memory summary (workspace memory/memory_summary.md). */
  memorySummary?: string;
  /** Include coding-agent base instructions (`base.md`). Default true; set
   *  false when coding/file/exec tools are disabled (e.g. front-desk runs). */
  includeBase?: boolean;
  /** Include local `.oma/memory/` & `learn`/`recall` instructions (`memory.md`).
   *  Default true for standalone read-write runs; set false when local memory
   *  tools are unmounted (ACP, read-only). */
  includeLocalMemory?: boolean;
}): string {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;

  const parts: string[] = [];
  if (input.includeBase !== false) parts.push(basePrompt.trim());
  parts.push(safetyPrompt.trim());

  const includeLocalMemory = input.includeLocalMemory !== false;
  if (includeLocalMemory) {
    const memoryBlock = input.memorySummary?.trim()
      ? `${memoryPrompt.trim()}\n\n<memory_summary>\n${input.memorySummary.trim()}\n</memory_summary>`
      : memoryPrompt.trim();
    parts.push(memoryBlock);
  } else if (input.memorySummary?.trim()) {
    parts.push(`<memory_summary>\n${input.memorySummary.trim()}\n</memory_summary>`);
  }

  if (input.hostPrompt?.trim()) {
    parts.push(input.hostPrompt.trim());
  }
  if (input.workspacePrompt?.trim()) {
    parts.push(`<workspace_context>\n${input.workspacePrompt.trim()}\n</workspace_context>`);
  }
  parts.push(`Current date: ${date}`, `Current working directory: ${input.cwd}`);
  return parts.join("\n\n");
}

/** Approximate token cap for the memory block injected into the system
 *  prompt (omp memories.summaryInjectionTokenLimit, ~4 chars/token). */
const MEMORY_INJECTION_CHARS = 5000;

/** Workspace memory block for prompt injection: the consolidated summary,
 *  backend-owned product memories (`product.md`), plus the tail of explicit
 *  lessons (`learned.md`). Absent when the agent has never written memories. */
export function readMemorySummary(cwd: string): string | undefined {
  const memDir = join(cwd, ".oma", "memory");
  let summary = "";
  let product = "";
  let learned = "";
  try {
    summary = readFileSync(join(memDir, "memory_summary.md"), "utf-8").trim();
  } catch {
    /* no summary yet */
  }
  try {
    product = readFileSync(join(memDir, "product.md"), "utf-8").trim();
  } catch {
    /* no product memories yet */
  }
  try {
    const lines = readFileSync(join(memDir, "learned.md"), "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    learned = lines.slice(0, 40).join("\n").trim();
  } catch {
    /* no lessons yet */
  }
  const merged = [
    summary,
    product ? `## Product memories\n${product}` : "",
    learned ? `## Learned lessons\n${learned}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (!merged) return undefined;
  return merged.length > MEMORY_INJECTION_CHARS
    ? `${merged.slice(0, MEMORY_INJECTION_CHARS)}\n…[memory truncated]`
    : merged;
}
