// NOTE: apps/backend/src/features/skill-pack/skill-index.ts is a COPY of the
// scanner below (the apps cannot import each other). This side is ahead: it
// supports `hide` / `user_invocable` frontmatter and resolves duplicate names
// first-wins ("project overrides user"). Change one, check the other.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SkillIndexEntry {
  readonly name: string;
  readonly description: string;
  readonly root: string;
  readonly relativePath: string;
  /** Frontmatter `hide: true`: still loadable via skill_load, but never
   *  listed in the system-prompt index (omp semantics). */
  readonly hide?: boolean;
  /** Frontmatter `user_invocable: false` (or kebab variant): not exposed as
   *  a /skill:<name> command. */
  readonly userInvocable?: boolean;
}

function isWithinRoot(root: string, target: string): boolean {
  try {
    const real = realpathSync(target);
    return real === root || real.startsWith(`${root}/`);
  } catch {
    return false;
  }
}

/** Canonicalize a skill root: resolve symlinks so realpath(target) comparisons
 *  work on platforms where the root itself is a symlink (e.g. macOS /tmp →
 *  /private/tmp). Returns null if the root does not exist or is not a dir. */
function canonicalRoot(root: string): string | null {
  try {
    const real = realpathSync(root);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** Safety bound: symlink containment + total entry count, not directory
 *  depth — deep but bounded trees are legitimate skill packs. */
const MAX_ENTRIES = 1000;

/** Scan configured roots for SKILL.md files, parse frontmatter for
 *  name + description (+ hide / user_invocable). Deterministic order by
 *  name. */
export function buildSkillIndex(roots: readonly string[]): SkillIndexEntry[] {
  // Roots are ordered by precedence: EARLIER root wins for the same skill
  // name (workspace .oma/skills beats plugin/.claude/.codex roots, matching
  // the "project overrides user" contract). First-wins, so later duplicates
  // are dropped.
  const byName = new Map<string, SkillIndexEntry>();
  for (const root of roots) {
    const canonical = canonicalRoot(root);
    if (!canonical) continue;
    const scanned: SkillIndexEntry[] = [];
    scanDir(canonical, canonical, scanned);
    for (const entry of scanned) {
      if (!byName.has(entry.name)) byName.set(entry.name, entry);
    }
  }
  // Deterministic Meta order: sort by name.
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function scanDir(root: string, currentDir: string, entries: SkillIndexEntry[]): void {
  let items: string[];
  try {
    items = readdirSync(currentDir);
  } catch {
    return;
  }

  for (const item of items) {
    if (entries.length >= MAX_ENTRIES) {
      throw new Error("skill pack contains too many skills (limit 1000)");
    }
    const fullPath = join(currentDir, item);
    if (!isWithinRoot(root, fullPath)) continue;

    if (item === "SKILL.md") {
      const parsed = parseFrontmatter(fullPath);
      if (parsed) {
        entries.push({
          name: parsed.name,
          description: parsed.description,
          root,
          relativePath: fullPath.slice(root.length + 1),
          ...(parsed.hide ? { hide: true } : {}),
          ...(parsed.userInvocable ? {} : { userInvocable: false }),
        });
      }
      continue;
    }
    try {
      if (statSync(fullPath).isDirectory()) scanDir(root, fullPath, entries);
    } catch {
      /* not a dir */
    }
  }
}

function parseFrontmatter(
  path: string,
): { name: string; description: string; hide: boolean; userInvocable: boolean } | null {
  try {
    const content = readFileSync(path, "utf8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    const frontmatter = match[1] ?? "";
    const name = frontmatter.match(/name:\s*(.+)/)?.[1]?.trim();
    if (!name) return null;
    const bool = (key: string, fallback: boolean): boolean => {
      const m = frontmatter.match(new RegExp(`^${key}:\\s*(true|false)\\s*$`, "m"));
      return m ? m[1] === "true" : fallback;
    };
    return {
      name,
      description: parseDescription(frontmatter),
      hide: bool("hide", false),
      // omp accepts both the camel and kebab spelling; default true.
      userInvocable:
        bool("user_invocable", true) &&
        bool("user-invocable", true) &&
        bool("disableModelInvocation", true) &&
        bool("disable-model-invocation", true),
    };
  } catch {
    return null;
  }
}

/** Minimal YAML folded-block support for `description: >` / `description: |`:
 *  join the following indented lines. Plain single-line descriptions are
 *  returned unchanged. (No YAML parser dependency for two fields.) */
function parseDescription(frontmatter: string): string {
  const line = frontmatter.match(/^description:\s*(.*)$/m)?.[1] ?? "";
  const trimmed = line.trim();
  if (trimmed !== ">" && trimmed !== "|") return trimmed;
  const lines = frontmatter.split("\n");
  const index = lines.findIndex((l) => l.startsWith("description:"));
  const body: string[] = [];
  for (const l of lines.slice(index + 1)) {
    if (!/^\s+/.test(l)) break;
    body.push(l.trim());
  }
  return body.join(" ");
}
