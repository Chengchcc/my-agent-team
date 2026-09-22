import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fetchGitSource, materializeZipSource } from "@chengchenccc/source-fetch";
import type { KnowledgePackRow } from "./entities.js";
import { type KnowledgeFrontmatter, parseKnowledgeFrontmatter } from "./frontmatter.js";
import type { KnowledgePackPort } from "./ports.js";

/** Lean install (ADR 0022): builtin dir copy / git clone / zip extract
 *  into <dataDir>/knowledge/<packId>. Knowledge packs have no internal
 *  layout constraint (any files). git/zip go through @chengchenccc/source-fetch
 *  so they get the same path-escape/symlink guard as skill-packs. */

export interface KnowledgeInstallDeps {
  dataDir: string;
  port: KnowledgePackPort;
  /** Builtin pack root: <name> directory copied wholesale. */
  builtinRoot?: string;
  zipBuffer?: Buffer;
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
  });
}

export function knowledgeInstallRoot(dataDir: string, packId: string): string {
  return join(dataDir, "knowledge", packId);
}

/** Kick off a pack install and drive it to a terminal status. Simple
 *  sequential install (ponytail: packs install rarely; one at a time). */
export async function installKnowledgePack(
  deps: KnowledgeInstallDeps,
  input: {
    id: string;
    name: string;
    description: string;
    sourceKind: "builtin" | "git" | "zip";
    sourceUrl: string | null;
    versionRef: string | null;
  },
): Promise<KnowledgePackRow> {
  const now = Date.now();
  const row = deps.port.create({
    id: input.id,
    name: input.name,
    description: input.description,
    sourceKind: input.sourceKind,
    sourceUrl: input.sourceUrl,
    versionRef: input.versionRef,
    sourceRev: null,
    installedRef: null,
    status: "installing",
    error: null,
    createdAt: now,
    updatedAt: now,
  });

  let target = knowledgeInstallRoot(deps.dataDir, input.id);
  let sourceRev: string | null = null;
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  try {
    if (input.sourceKind === "builtin") {
      // name selects a subdirectory of builtinRoot — a bare segment — or the
      // literal "." for the root itself (the project's own docs ARE the pack;
      // there is no separate knowledge-packs directory to keep in sync).
      // Without the segment check, "../" copies arbitrary directories into the
      // pack, where the files API then reads them back out.
      if (input.name !== "." && !/^[a-zA-Z0-9_-]+$/.test(input.name)) {
        throw new Error(`invalid builtin pack name: ${input.name}`);
      }
      const src =
        deps.builtinRoot === undefined
          ? null
          : input.name === "."
            ? deps.builtinRoot
            : join(deps.builtinRoot, input.name);
      if (!src || !existsSync(src)) throw new Error(`builtin pack not found: ${input.name}`);
      const res = await run("cp", ["-a", `${src}/.`, target], "/");
      if (res.exitCode !== 0) throw new Error(`copy failed: ${res.stderr.slice(0, 200)}`);
    } else if (input.sourceKind === "git") {
      if (!input.sourceUrl) throw new Error("sourceUrl required for git packs");
      const fetched = await fetchGitSource({
        url: input.sourceUrl,
        dataDir: join(deps.dataDir, "knowledge"),
        slug: input.id,
        ...(input.versionRef ? { ref: input.versionRef } : {}),
      });
      target = fetched.root;
      sourceRev = fetched.rev;
    } else {
      const buf = deps.zipBuffer;
      if (!buf || buf.length === 0) throw new Error("zip upload missing for zip packs");
      const fetched = await materializeZipSource({
        buffer: buf,
        dataDir: join(deps.dataDir, "knowledge"),
        slug: input.id,
      });
      target = fetched.root;
      sourceRev = fetched.rev;
    }
    return deps.port.update(input.id, {
      status: "ready",
      installedRef: target,
      sourceRev,
      error: null,
      updatedAt: Date.now(),
    })!;
  } catch (err) {
    return (
      deps.port.update(input.id, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        updatedAt: Date.now(),
      }) ?? row
    );
  }
}

/** Progressive index of one pack (ADR 0022: the bridge writes index.md).
 *
 *  This text is injected into every run's system prompt, so it carries ONLY
 *  what a model needs to decide whether to open a file: its path, and — when
 *  the file declares frontmatter — its title, one-line description and tags.
 *  Bodies are never inlined; they are fetched with knowledge_read /
 *  knowledge_search. `hide: true` keeps a file readable but out of the index
 *  (mirrors the skill index's `hide`). Files without frontmatter are listed
 *  by path alone rather than omitted: a pack that predates the contract still
 *  works. */
export function knowledgePackIndex(pack: {
  name: string;
  description: string;
  installedRef: string | null;
}): string {
  const root = pack.installedRef;
  if (!root || !existsSync(root)) return "";
  const lines: string[] = [`## ${pack.name}`, "", pack.description, ""];
  const MAX_LINES = 250;
  const MAX_DESC = 120;
  const annotate = (rel: string, full: string): string | null => {
    if (!rel.endsWith(".md")) return `- \`${rel}\``;
    let meta: KnowledgeFrontmatter;
    try {
      meta = parseKnowledgeFrontmatter(readFileSync(full, "utf-8"));
    } catch {
      return `- \`${rel}\``;
    }
    if (meta.hide) return null;
    const bits: string[] = [];
    if (meta.title) bits.push(meta.title);
    if (meta.description) {
      const d =
        meta.description.length > MAX_DESC
          ? `${meta.description.slice(0, MAX_DESC - 1)}…`
          : meta.description;
      bits.push(d);
    }
    if (meta.tags.length > 0) bits.push(`[${meta.tags.join(", ")}]`);
    return bits.length === 0 ? `- \`${rel}\`` : `- \`${rel}\` — ${bits.join(" · ")}`;
  };
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || lines.length > MAX_LINES) return;
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git" || name === "index.md") continue;
      const full = join(dir, name);
      const rel = full.slice(root.length + 1);
      let entry: string | null;
      try {
        if (statSync(full).isDirectory()) {
          lines.push(`${"  ".repeat(depth)}- ${rel}/`);
          walk(full, depth + 1);
          continue;
        }
        entry = annotate(rel, full);
      } catch {
        continue; // unreadable entry
      }
      if (entry !== null) lines.push(`${"  ".repeat(depth)}${entry}`);
    }
  };
  walk(root, 0);
  return lines.join("\n");
}
