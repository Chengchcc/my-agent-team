import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginTool } from "../index.js";
import { buildSkillIndex } from "../tools/skills.js";
import { managedSkillsDir, writeManagedSkill } from "./managed-skills.js";
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
  /** Authored skill roots (the Run's frozen skillRoots): used to refuse
   *  minting a managed skill under a name an authored skill already claims. */
  skillRoots?: readonly string[];
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
      "into future sessions alongside the memory summary. Optionally also mint or " +
      "update a managed skill (isolated <agentDir>/managed-skills, surfaced as a " +
      "normal skill next session) — pass `skill` only for a repeatable procedure " +
      "worth codifying as SKILL.md, never for a plain fact.",
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
        skill: {
          type: "object",
          description:
            "Optional: also create or update a managed skill in the same call. " +
            "Only for repeatable procedures; ordinary facts stay memory-only.",
          properties: {
            action: { type: "string", enum: ["create", "update"] },
            name: { type: "string", description: "kebab-case skill name" },
            description: { type: "string", description: "one-line when-to-use" },
            body: {
              type: "string",
              description: "the SKILL.md body in markdown, no frontmatter",
            },
          },
          required: ["action", "name", "description", "body"],
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
      const duplicate = existing.some((l) => normalize(l) === key);
      const next = [line, ...existing].slice(0, MAX_LESSONS);
      if (!duplicate) writeLessons(next);
      // Vector double-write: the index update must never gate the lesson.
      // learned.md already holds it, and a cold provider begins by fetching
      // ~135MB of ONNX weights — awaiting that inside a tool call stalls the
      // run for minutes. Fire-and-forget; the file is the source of truth and
      // the DB is only an index.
      if (opts.vector && !duplicate) {
        void retainMemory(opts.vector.store, opts.vector.provider, {
          content: cappedContent,
          ...(cappedContext ? { context: cappedContext } : {}),
          source: "learn",
        }).catch(() => {
          /* file layer already won */
        });
      }
      const base = {
        learned: !duplicate,
        ...(duplicate ? { reason: "duplicate lesson already captured" } : { count: next.length }),
      };
      const skill = parseSkillArg(args.skill);
      if (!skill) return base;
      try {
        // A managed skill resolves below any authored skill of the same name
        // (dead-last root), so minting one under a claimed name writes a file
        // that never surfaces. Refuse instead of reporting a false "Created".
        if (
          skill.action === "create" &&
          isClaimedByAuthoredSkill(skill.name, opts.skillRoots ?? [])
        ) {
          return {
            ...base,
            error: `an authored skill named "${skill.name}" already exists; managed skills cannot override it — choose a different name`,
            isError: true,
          };
        }
        const { path } = writeManagedSkill(skill);
        return { ...base, skill: { name: skill.name, path } };
      } catch (err) {
        // Partial outcome: the lesson already won; the skill did not.
        return {
          ...base,
          error: `lesson ${duplicate ? "already captured" : "stored"}, but the managed skill could not be written: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

interface SkillArg {
  action: "create" | "update";
  name: string;
  description: string;
  body: string;
}

function parseSkillArg(raw: unknown): SkillArg | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const action = o.action === "update" ? "update" : o.action === "create" ? "create" : null;
  const name = typeof o.name === "string" ? o.name : "";
  const description = typeof o.description === "string" ? o.description : "";
  const body = typeof o.body === "string" ? o.body : "";
  if (!action || !name || !description || !body) return null;
  return { action, name, description, body };
}

/** Whether an authored (non-managed) skill already claims `name`. */
function isClaimedByAuthoredSkill(name: string, roots: readonly string[]): boolean {
  let managedRoot: string | null = null;
  try {
    managedRoot = realpathSync(managedSkillsDir());
  } catch {
    managedRoot = null;
  }
  return buildSkillIndex(roots).some(
    (e) => e.name === name.trim().toLowerCase() && e.root !== managedRoot,
  );
}
