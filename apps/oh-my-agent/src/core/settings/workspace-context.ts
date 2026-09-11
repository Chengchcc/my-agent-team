import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { agentDir } from "../session/session-file.js";

/** cwd-based workspace context (ADR 0003 decision 6): the oma's
 *  meta lives in workspace files, read natively — no run-input injection.
 *  Only used as the FALLBACK when the run input does not carry explicit
 *  values (Loop scopes still pass their own LOOP.md config).
 *
 *  Context-file discovery absorbs oh-my-pi's context-files.md semantics,
 *  ponytail cut: AGENTS.md only (no multi-provider discovery), no @
 *  imports (the agent has read tools), and no RULES.md stickiness (the
 *  prompt lands in the SYSTEM role, which is sticky by construction —
 *  omp needs re-attachment because it injects into the opening message). */

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** Identity files: oma-native (cwd-only, plain text, unwrapped). */
const IDENTITY_FILES = ["SOUL.md", "USER.md"] as const;

/** Directories whose AGENTS.md contributes to the prompt, ordered NEAR →
 *  FAR: cwd first, then ancestors up to the repository root (a directory
 *  containing .git, INCLUSIVE) — or, when no repository root exists, up to
 *  and including the home directory (omp agents-md boundary rules).
 *  `opts.home` overrides the home boundary for hermetic tests. */
export function contextDirChain(cwd: string, opts?: { home?: string }): string[] {
  const home = opts?.home ?? homedir();
  const dirs: string[] = [];
  let dir = cwd;
  for (;;) {
    dirs.push(dir);
    if (existsSync(join(dir, ".git"))) break; // repo root: inclusive boundary
    if (dir === home) break; // home: inclusive boundary (no repo root above)
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    if (parent === home && !existsSync(join(parent, ".git"))) {
      dirs.push(parent); // entering home without a repo above: include it
      break;
    }
    dir = parent;
  }
  return dirs;
}

/** The user-scope context file, last in the injection order. */
function userContextPath(): string {
  return join(agentDir(), "AGENTS.md");
}

/** Non-empty AGENTS.md under the immediate subdirectories of cwd — files
 *  the walk did NOT load. Surfaced as pointers, never as content. */
function deeperContextPointers(cwd: string, loaded: ReadonlySet<string>): string[] {
  const pointers: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(cwd);
  } catch {
    return pointers;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const dir = join(cwd, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const candidate = join(dir, "AGENTS.md");
    if (loaded.has(candidate)) continue;
    const text = readTextOrNull(candidate);
    if (text?.trim()) pointers.push(candidate);
  }
  return pointers.sort();
}

/** The system prompt = SOUL.md (identity) + USER.md (user context) + the
 *  project AGENTS.md chain (root-first, cwd last — later files are more
 *  prominent) + the user-scope AGENTS.md, wrapped in <repo-rules>/<file>
 *  markers (omp injection shape) + the knowledge index (ADR 0022).
 *  Byte-identical files collapse; the more prominent copy survives. */
export function readWorkspaceSystemPrompt(
  cwd: string,
  opts?: { home?: string },
): string | undefined {
  const parts: string[] = [];

  // Identity first (plain, unchanged semantics).
  for (const f of IDENTITY_FILES) {
    const text = readTextOrNull(join(cwd, f));
    if (text?.trim()) parts.push(text.trim());
  }

  // Context files: far ancestors first, cwd last, user scope after.
  // ponytail: content dedupe keeps the LAST copy (omp's surviving-copy rule).
  const files: Array<{ path: string; text: string }> = [];
  for (const dir of [...contextDirChain(cwd, opts)].reverse()) {
    const path = join(dir, "AGENTS.md");
    const text = readTextOrNull(path);
    if (text?.trim()) files.push({ path, text: text.trim() });
  }
  const userFile = userContextPath();
  const userText = readTextOrNull(userFile);
  if (userText?.trim()) files.push({ path: userFile, text: userText.trim() });

  // omp surviving-copy rule: byte-identical files collapse; the more
  // prominent (later) copy survives.
  const byContent = new Map<string, { path: string; text: string }>();
  for (const f of files) byContent.set(f.text, f);
  const unique = [...byContent.values()];
  if (unique.length > 0) {
    const body = unique.map((f) => `<file path="${f.path}">\n${f.text}\n</file>`).join("\n");
    parts.push(
      `<repo-rules>\nYou MUST follow the context files below for all tasks:\n${body}\n</repo-rules>`,
    );
  }

  const knowledgeIndex = readTextOrNull(join(cwd, "knowledge", "index.md"));
  if (knowledgeIndex && knowledgeIndex.trim() !== "") {
    parts.push(`<available_knowledge>\n${knowledgeIndex.trim()}\n</available_knowledge>`);
  }

  // Pointers to deeper AGENTS.md files: read-before-edit, not injected.
  const loaded = new Set(unique.map((f) => f.path));
  const pointers = deeperContextPointers(cwd, loaded);
  if (pointers.length > 0) {
    const list = pointers.map((p) => `  <file path="${p}" />`).join("\n");
    parts.push(
      `<dir-context>\nThe context files below were NOT loaded (they live below the working directory). Read one before editing files under its directory:\n${list}\n</dir-context>`,
    );
  }

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Skill roots = every directory under .oma/skills (symlinked packs via
 *  the workspace bridge). Each is scanned for SKILL.md by the progressive
 *  skill plugin. */
export function scanWorkspaceSkillRoots(cwd: string): string[] {
  const skillsDir = join(cwd, ".oma", "skills");
  if (!existsSync(skillsDir)) return [];
  const roots: string[] = [];
  for (const entry of readdirSync(skillsDir)) {
    const p = join(skillsDir, entry);
    try {
      if (statSync(p).isDirectory()) roots.push(p);
    } catch {
      /* dangling symlink or race: skip */
    }
  }
  return roots;
}
