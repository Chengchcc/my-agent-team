import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@chengchenccc/ai";
import type { EmbeddingProvider, VectorMemoryStore } from "@chengchenccc/embedding";
import { extractText, type Message } from "@chengchenccc/message";
import { redactMemorySecrets } from "./learn.js";

/**
 * Autonomous memory pipeline (v1, OMP AutoLearn-style, standalone CLI/TUI).
 *
 * After a COMPLETED standalone oma run:
 *   1. asks the model to extract durable facts from the run transcript
 *   2. redacts secrets and writes `.oma/memory/facts/<runId>.md` atomically;
 *   3. consolidates into `.oma/memory/memory_summary.md` & `MEMORY.md` atomically;
 *   4. prepends the summary to the NEXT Run's system prompt (read side).
 *
 * Disabled in ACP/product mode (`autonomousMemory: false`), where the backend
 * owns long-term memory and writes `.oma/memory/product.md`.
 * Every failure is swallowed: memory must never fail or slow the Run.
 * Env: OMA_MEMORY_EXTRACT=0 disables; OMA_MEMORY_MODEL=<provider>/<model>
 * overrides the extract/merge model (default: the Run's own model).
 */

function writeFileAtomic(target: string, content: string): void {
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, target);
}

// omp AutoLearn bar: capture sparingly, only after the run actually SOLVED
// or REVEALED something — one strong reusable lesson beats several vague
// ones, and a run that merely chatted must learn nothing.
const EXTRACT_PROMPT = `You are a memory extractor for a coding agent.
Extract ONLY lessons that would change how a future run works in this
workspace: a non-obvious fix, a discovered project convention, a decision
with its why, a pitfall with its fix, or a workflow that worked.

The bar is HIGH. The run must have actually solved or revealed something;
a greeting, a question answered from general knowledge, or plain chatter
has NOTHING to learn — return {"facts":[]} without hesitation.

NEVER extract:
- static configuration: skill/tool listings, model catalogs, agent
  capabilities, repository or directory structure — re-derivable any time
- summaries of what the run did (the transcript already knows that)
- transient details without reuse value, or unverified guesses

Capture sparingly: one strong, specific lesson beats several vague ones.
When in doubt, don't write.

Return STRICT JSON only:
{"facts":[{"content":"one durable lesson","context":"where it applies (file/module/scope)"}]}`;

const CONSOLIDATE_PROMPT = `You maintain the agent's long-term memory artifacts
(.oma/memory/MEMORY.md and .oma/memory/memory_summary.md). Merge the NEW
facts into the EXISTING artifacts:
- MEMORY.md: a curated long-term document, grouped thematically, keeping
  every durable lesson with enough context to act on.
- memory_summary.md: a compact digest injected into the system prompt at
  session start (keep it under 3500 characters so it never crowds out other
  workspace memories).
Write in the same language as the facts. Drop facts already covered and
anything static or re-derivable from the repo. Return STRICT JSON only:
{"summary":"compact digest","memory":"curated long-term document"}`;

const EXTRACT_TIMEOUT_MS = 60_000;
const TRANSCRIPT_BUDGET_CHARS = 8_000;

interface ExtractedFact {
  content: string;
  context?: string;
}

interface ExtractResult {
  facts: ExtractedFact[];
}

/** Vector index double-write target (store + optional embedding provider). */
export interface VectorMemoryInput {
  store: VectorMemoryStore;
  provider: EmbeddingProvider | null;
}

export interface AutonomousMemoryInput {
  modelRuntime: ModelRuntime;
  /** Optional vector index: fresh facts double-write into it (best-effort,
   *  exactly like the learn tool). */
  vector?: VectorMemoryInput | null;
  /** false = the pass is disabled for this Run (runtime knob). */
  enabled?: boolean;
  /** Pinned extract/merge model (`provider/model`); absent = auto-pick. */
  memoryModel?: string;
  /** Canonical "<provider>/<model>" of the Run's model. */
  modelId: string;
  workspaceRoot: string;
  runId: string;
  messages: readonly Message[];
  compactions: readonly string[];
}

/** Result of one memory-learn pass. `ran` is true when the pipeline made
 * its extraction call (facts may still dedup to zero); false when disabled,
 * empty, or failed — best-effort semantics, never throws. Surfaces use it
 * for the omp-style "learn" indicator. */
export interface MemoryLearnResult {
  readonly ran: boolean;
  readonly freshFacts: number;
}

export async function extractAutonomousMemory(
  input: AutonomousMemoryInput,
): Promise<MemoryLearnResult> {
  try {
    if (input.enabled === false) return { ran: false, freshFacts: 0 };
    // Default: the cheapest available catalog model (memory extraction is
    // quality-tolerant); an explicit memoryModel overrides; fall back to the
    // Run's own model when the catalog is empty/unreadable.
    const modelRef = await resolveMemoryModel(input.modelRuntime, input.modelId, input.memoryModel);
    const transcript = buildTranscript(input.messages, input.compactions);
    if (transcript.trim().length === 0) return { ran: false, freshFacts: 0 };

    const facts = parseFacts(
      await callModel(
        input.modelRuntime,
        modelRef,
        EXTRACT_PROMPT,
        `<transcript>\n${transcript}\n</transcript>`,
      ),
    );
    if (facts.length === 0) return { ran: true, freshFacts: 0 };

    const memDir = join(input.workspaceRoot, ".oma", "memory");
    const factsDir = join(memDir, "facts");
    // Cross-run dedup: only genuinely NEW facts are persisted per run (and
    // fed to consolidation). Repeated learnings from later runs are dropped,
    // so memory/facts/*.md stays a unique-facts set, not an append log.
    const existing = readExistingFactContents(factsDir);
    const sanitized = facts.map((f) => ({
      content: redactMemorySecrets(f.content),
      ...(f.context ? { context: redactMemorySecrets(f.context) } : {}),
    }));
    const fresh = sanitized.filter((f) => !existing.has(normalizeFact(f.content)));
    if (fresh.length === 0) return { ran: true, freshFacts: 0 };

    mkdirSync(factsDir, { recursive: true });
    writeFileAtomic(join(factsDir, `${input.runId}.md`), renderFacts(input.runId, fresh));

    // Vector index double-write: best-effort per fact (an embedding failure
    // must never fail the memory pass); the file layer stays the truth.
    if (input.vector) {
      const { retainMemory } = await import("@chengchenccc/embedding");
      for (const fact of fresh) {
        try {
          await retainMemory(input.vector.store, input.vector.provider, {
            content: fact.content,
            ...(fact.context ? { context: fact.context } : {}),
            source: "autonomous",
          });
        } catch {
          /* index-only loss */
        }
      }
    }

    const oldSummary = readTextOrNull(join(memDir, "memory_summary.md"));
    const oldMemory = readTextOrNull(join(memDir, "MEMORY.md"));
    const raw = await callModel(
      input.modelRuntime,
      modelRef,
      CONSOLIDATE_PROMPT,
      `<existing_summary>\n${oldSummary ?? "(none)"}\n</existing_summary>\n\n<existing_memory>\n${oldMemory ?? "(none)"}\n</existing_memory>\n\n<new_facts>\n${renderFacts(input.runId, fresh)}\n</new_facts>`,
    );
    const consolidated = parseConsolidation(raw);
    if (consolidated.summary) {
      writeFileAtomic(join(memDir, "memory_summary.md"), redactMemorySecrets(consolidated.summary));
    }
    if (consolidated.memory) {
      writeFileAtomic(join(memDir, "MEMORY.md"), redactMemorySecrets(consolidated.memory));
    }
    return { ran: true, freshFacts: fresh.length };
  } catch (err) {
    // Memory is best-effort: never fail or slow the Run over it.
    console.error(
      "[oma] autonomous memory skipped:",
      err instanceof Error ? err.message : String(err),
    );
    return { ran: false, freshFacts: 0 };
  }
}

async function resolveMemoryModel(
  modelRuntime: ModelRuntime,
  runModelId: string,
  explicit?: string,
): Promise<string> {
  if (explicit) return explicit;
  try {
    const catalog = await modelRuntime.getCatalog();
    const candidates = catalog.models.filter((m) => m.available !== false);
    if (candidates.length > 0) {
      const costOf = (m: (typeof candidates)[number]) => m.cost.input + m.cost.output;
      const cheapest = candidates.reduce((a, b) => (costOf(a) <= costOf(b) ? a : b));
      // On a cost tie prefer the Run's own model: never surprise-upgrade
      // (or downgrade) the memory model when the catalog gives no reason.
      const runEntry = candidates.find((m) => `${m.providerId}/${m.modelId}` === runModelId);
      if (runEntry && costOf(runEntry) <= costOf(cheapest)) return runModelId;
      return `${cheapest.providerId}/${cheapest.modelId}`;
    }
  } catch {
    /* unreadable catalog — fall back to the Run's model */
  }
  return runModelId;
}

function clipInline(text: string, maxChars: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length <= maxChars ? s : `${s.slice(0, maxChars - 1)}…`;
}

function buildTranscript(messages: readonly Message[], compactions: readonly string[]): string {
  const lines: string[] = [];
  for (const c of compactions) {
    if (c.trim()) lines.push(`[compaction summary]\n${c.trim()}`);
  }
  for (const m of messages) {
    const label = m.role === "assistant" ? "Assistant" : m.role === "user" ? "User" : m.role;
    const parts: string[] = [];
    const text = extractText(m).trim();
    if (text) parts.push(text);
    for (const block of m.blocks ?? []) {
      if (block.type === "tool_use") {
        let args = "";
        try {
          args = clipInline(JSON.stringify(block.input ?? {}), 240);
        } catch {
          args = "[unserializable]";
        }
        parts.push(`[tool_use ${block.name}] ${args}`);
      } else if (block.type === "tool_result") {
        const errTag = block.is_error ? " (error)" : "";
        parts.push(`[tool_result${errTag}] ${clipInline(block.content, 300)}`);
      }
    }
    if (parts.length > 0) lines.push(`${label}: ${parts.join("\n")}`);
  }
  const full = lines.join("\n\n");
  // Keep the TAIL of long transcripts so final fixes, errors, and conclusions
  // survive rather than being truncated off the end.
  return full.length <= TRANSCRIPT_BUDGET_CHARS ? full : full.slice(-TRANSCRIPT_BUDGET_CHARS);
}

async function callModel(
  modelRuntime: ModelRuntime,
  modelRef: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const slash = modelRef.indexOf("/");
  const providerId = slash > 0 ? modelRef.slice(0, slash) : modelRef;
  const modelId = slash > 0 ? modelRef.slice(slash + 1) : modelRef;
  let text = "";
  for await (const chunk of modelRuntime.stream(
    providerId,
    modelId,
    [
      { role: "system", text: systemPrompt },
      { role: "user", text: userPrompt },
    ],
    {
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    },
  )) {
    if (chunk.delta?.type === "text" && chunk.delta.text) text += chunk.delta.text;
  }
  return text.trim();
}

function parseFacts(raw: string): ExtractedFact[] {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let parsed: ExtractResult;
  try {
    parsed = JSON.parse(m[0]) as ExtractResult;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.facts)) return [];
  return parsed.facts.filter(
    (f): f is ExtractedFact => typeof f?.content === "string" && f.content.trim().length > 0,
  );
}

function parseConsolidation(raw: string): { summary?: string; memory?: string } {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try {
    const parsed = JSON.parse(m[0]) as { summary?: unknown; memory?: unknown };
    return {
      ...(typeof parsed.summary === "string" && parsed.summary.trim()
        ? { summary: parsed.summary.trim() }
        : {}),
      ...(typeof parsed.memory === "string" && parsed.memory.trim()
        ? { memory: parsed.memory.trim() }
        : {}),
    };
  } catch {
    return {};
  }
}

function renderFacts(runId: string, facts: readonly ExtractedFact[]): string {
  const lines = [`---`, `runId: ${runId}`, `createdAt: ${Date.now()}`, `---`, ""];
  for (const f of facts) {
    lines.push(
      f.context?.trim() ? `- **${f.context.trim()}** ${f.content.trim()}` : `- ${f.content.trim()}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Normalized fact identity: trimmed, case-folded bullet content. */
function normalizeFact(content: string): string {
  return content.trim().toLowerCase();
}

/** Every fact bullet already persisted across all facts/*.md files
 *  (pipeline and agent-written alike), best-effort parse of `- ` lines. */
function readExistingFactContents(factsDir: string): Set<string> {
  const set = new Set<string>();
  let files: string[];
  try {
    files = readdirSync(factsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return set;
  }
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(factsDir, file), "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("- ")) continue;
      const content = t
        .slice(2)
        .replace(/^\*\*[^*]+\*\*\s*/, "")
        .trim();
      if (content) set.add(normalizeFact(content));
    }
  }
  return set;
}

function readTextOrNull(path: string): string | null {
  try {
    const text = readFileSync(path, "utf-8");
    return text.trim() || null;
  } catch {
    return null;
  }
}
