import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginTool } from "../index.js";
import type { VectorMemory } from "./vector-memory.js";
import { retainMemory } from "./vector-recall.js";

/** Explicit durable-lesson capture (omp learn tool, local backend): newest
 *  first in `.oma/memory/learned.md`, deduplicated by normalized content,
 *  secret-redacted, capped at MAX_LESSONS entries. The consolidation
 *  pipeline never overwrites learned.md. */

const MAX_LESSONS = 100;
const MAX_CONTENT_CHARS = 2000;
const MAX_CONTEXT_CHARS = 400;
const SECRET_PATTERN = /\b(sk|pk|ghp|gho|ghu|xox[baprs]|AIza|AKIA)[-_A-Za-z0-9]{16,}\b/g;

function redact(text: string): string {
  return text.replace(SECRET_PATTERN, "[redacted]");
}

function normalize(content: string): string {
  return content.trim().replace(/\s+/g, " ").toLowerCase();
}

export function createLearnTool(opts: {
  workspaceRoot: string;
  vector?: VectorMemory | null;
}): PluginTool {
  const memDir = join(opts.workspaceRoot, ".oma", "memory");
  const learnedPath = join(memDir, "learned.md");

  function readLessons(): string[] {
    try {
      return readFileSync(learnedPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim());
    } catch {
      return [];
    }
  }

  function writeLessons(lines: readonly string[]): void {
    mkdirSync(memDir, { recursive: true });
    writeFileSync(learnedPath, `${lines.join("\n")}\n`, "utf-8");
  }

  return {
    name: "learn",
    description:
      "Capture one durable lesson for this workspace (omp learned.md): a constraint, " +
      "a decision with its why, a workflow that worked, a pitfall with its fix, or a " +
      "discovered project convention. Saved newest-first, deduplicated, and injected " +
      "into future sessions alongside the memory summary.",
    inputSchema: {
      type: "object",
      properties: {
        memory: {
          type: "string",
          description: "The durable lesson (max 2000 chars)",
        },
        context: {
          type: "string",
          description: "Optional: where it applies (file/module/scope), max 400 chars",
        },
      },
      required: ["memory"],
    },
    async execute(args) {
      const content = typeof args.memory === "string" ? args.memory.trim() : "";
      if (!content) return { learned: false, error: "memory is required" };
      const context = typeof args.context === "string" ? args.context.trim() : "";
      const cappedContent = redact(content.replace(/\s+/g, " ").slice(0, MAX_CONTENT_CHARS));
      const cappedContext = context ? redact(context.slice(0, MAX_CONTEXT_CHARS)) : "";
      const line = context
        ? `- [${new Date().toISOString().slice(0, 10)}] **${cappedContext}** ${cappedContent}`
        : `- [${new Date().toISOString().slice(0, 10)}] ${cappedContent}`;
      const key = normalize(line);
      const existing = readLessons();
      if (existing.some((l) => normalize(l) === key)) {
        return { learned: false, reason: "duplicate lesson already captured" };
      }
      const next = [line, ...existing].slice(0, MAX_LESSONS);
      writeLessons(next);
      // Vector double-write (best-effort index update; the file stays the
      // source of truth).
      if (opts.vector) {
        try {
          await retainMemory(opts.vector.store, opts.vector.provider, {
            content: cappedContent,
            ...(cappedContext ? { context: cappedContext } : {}),
            source: "learn",
          });
        } catch {
          /* file layer already won */
        }
      }
      return { learned: true, count: next.length };
    },
  };
}
