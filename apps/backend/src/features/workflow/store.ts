import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  parseWorkflow,
  type WorkflowConcurrencyPolicy,
  type WorkflowDefinition,
} from "@chengchenccc/workflow";

export const WORKFLOW_ID_RE = /^[A-Za-z0-9._-]+$/;

export interface WorkflowCommitInfo {
  author: string;
  summary: string;
}

export interface WorkflowHistoryEntry {
  commit: string;
  author: string;
  timestamp: number;
  summary: string;
}

export interface WorkflowDefinitionStore {
  readonly dir: string;
  readonly gitReady: boolean;
  /** File path inside `dir` for a validated workflowId (throws on invalid id). */
  filePath(workflowId: string): string;
  exists(workflowId: string): boolean;
  readRaw(workflowId: string): string | null;
  readParsed(workflowId: string): WorkflowDefinition | null;
  listIds(): string[];
  statMtime(workflowId: string): number | null;
  /** Atomic write + git commit. Returns the resulting git commit hash (or null if git unavailable). */
  write(workflowId: string, definition: unknown, commit: WorkflowCommitInfo): string | null;
  /** Delete definition file + git commit. Returns true if the file existed. */
  remove(workflowId: string, commit: WorkflowCommitInfo): boolean;
  /** Recent git commits touching `<workflowId>.workflow.json`, newest first. */
  history(workflowId: string, limit?: number): WorkflowHistoryEntry[];
  /** Read definition JSON at a specific git commit hash. */
  readAtCommit(workflowId: string, commitHash: string): string | null;
  /** Restore a prior git commit as a new validated commit on HEAD. */
  revert(
    workflowId: string,
    commitHash: string,
    commit: WorkflowCommitInfo,
  ): { definition: WorkflowDefinition; commit: string | null };
}

export interface WorkflowRiskAssessment {
  readonly requiresApproval: boolean;
  readonly reasons: ReadonlyArray<"script" | "cron">;
  readonly scriptNodes: ReadonlyArray<{ id: string; code: string; timeoutMs?: number }>;
  readonly cronTriggers: ReadonlyArray<{ cron: string }>;
}

/** ADR 0084 D2: classify whether saving `nextDef` over `prevDef` introduces or
 *  modifies executable `script` node code or enabled `cron` triggers. Pure
 *  declarative SOP changes (prompts, agent routing, human gates, rework edges)
 *  require no extra approval; script/cron mutations route to human adoption. */
export function classifyWorkflowRisk(
  prevDef: WorkflowDefinition | null,
  nextDef: WorkflowDefinition,
): WorkflowRiskAssessment {
  const prevScripts = new Map<string, { code: string; runtime?: string; timeoutMs?: number }>();
  if (prevDef) {
    for (const n of prevDef.nodes) {
      if (n.type === "script") {
        prevScripts.set(n.id, { code: n.code, runtime: n.runtime, timeoutMs: n.timeoutMs });
      }
    }
  }
  const scriptNodes: Array<{ id: string; code: string; timeoutMs?: number }> = [];
  for (const n of nextDef.nodes) {
    if (n.type !== "script") continue;
    const prev = prevScripts.get(n.id);
    if (
      !prev ||
      prev.code !== n.code ||
      prev.runtime !== n.runtime ||
      prev.timeoutMs !== n.timeoutMs
    ) {
      scriptNodes.push({
        id: n.id,
        code: n.code,
        ...(n.timeoutMs !== undefined ? { timeoutMs: n.timeoutMs } : {}),
      });
    }
  }

  const prevEnabledCrons = new Set<string>();
  if (prevDef) {
    for (const tr of prevDef.triggers ?? []) {
      if (tr.type === "cron" && tr.enabled !== false) {
        prevEnabledCrons.add(tr.cron.trim());
      }
    }
  }
  const cronTriggers: Array<{ cron: string }> = [];
  for (const tr of nextDef.triggers ?? []) {
    if (tr.type === "cron" && tr.enabled !== false && !prevEnabledCrons.has(tr.cron.trim())) {
      cronTriggers.push({ cron: tr.cron.trim() });
    }
  }

  const reasons: Array<"script" | "cron"> = [];
  if (scriptNodes.length > 0) reasons.push("script");
  if (cronTriggers.length > 0) reasons.push("cron");
  return {
    requiresApproval: reasons.length > 0,
    reasons,
    scriptNodes,
    cronTriggers,
  };
}

/** ADR 0084 D7: resolve effective concurrency policy for a workflow definition.
 *  Explicit `concurrencyPolicy` wins; otherwise cron workflows default to
 *  `"forbid"` and on-demand SOP workflows default to `"per_requirement"`. */
export function resolveConcurrencyPolicy(def: WorkflowDefinition): WorkflowConcurrencyPolicy {
  if (def.concurrencyPolicy) return def.concurrencyPolicy;
  const hasEnabledCron = (def.triggers ?? []).some((t) => t.type === "cron" && t.enabled !== false);
  return hasEnabledCron ? "forbid" : "per_requirement";
}

function validateWorkflowId(workflowId: string): string {
  if (!WORKFLOW_ID_RE.test(workflowId)) {
    throw new Error(`invalid workflow id: ${workflowId}`);
  }
  return workflowId;
}

const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

/** ADR 0084 D1: Git-backed filesystem store for `<dataDir>/workflows/*.workflow.json`.
 *  Follows the exact `wiki/adapter-fs.ts` pattern: auto `git init`, atomic
 *  `tmp + rename` writes, attributable per-write commits, and graceful fallback
 *  when git is unavailable. */
export function createFsWorkflowStore(root: string): WorkflowDefinitionStore {
  mkdirSync(root, { recursive: true });
  const gitReady = ensureGitRepo(root);

  function ensureGitRepo(dir: string): boolean {
    if (existsSync(join(dir, ".git"))) return true;
    const init = Bun.spawnSync(["git", "init", "-q"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (init.exitCode !== 0) {
      console.warn(`[workflow] git unavailable at ${dir}; definitions work, history does not`);
      return false;
    }
    Bun.spawnSync(["git", "config", "user.email", "workflow@local"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    Bun.spawnSync(["git", "config", "user.name", "workflow"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    // Baseline commit for any pre-existing *.workflow.json files.
    const existing = readdirSync(dir).filter((f) => f.endsWith(".workflow.json"));
    if (existing.length > 0) {
      Bun.spawnSync(["git", "add", "--", ...existing], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      Bun.spawnSync(["git", "commit", "-q", "-m", "chore: initial workflow definitions [system]"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
    }
    return true;
  }

  function relFile(workflowId: string): string {
    return `${validateWorkflowId(workflowId)}.workflow.json`;
  }

  function commitFile(filename: string, info: WorkflowCommitInfo, deleted = false): string | null {
    if (!gitReady) return null;
    const stageCmd = deleted
      ? ["git", "add", "-A", "--", filename]
      : ["git", "add", "--", filename];
    const add = Bun.spawnSync(stageCmd, { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (add.exitCode !== 0) {
      console.warn(`[workflow] git add failed for ${filename}`);
      return null;
    }
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: info.author,
      GIT_AUTHOR_EMAIL: "workflow@local",
      GIT_COMMITTER_NAME: info.author,
      GIT_COMMITTER_EMAIL: "workflow@local",
    };
    const res = Bun.spawnSync(
      ["git", "commit", "-q", "-m", `${info.summary} [${info.author}]`, "--", filename],
      { cwd: root, env, stdout: "pipe", stderr: "pipe" },
    );
    if (res.exitCode !== 0) {
      const said = `${res.stdout.toString()}${res.stderr.toString()}`;
      if (!said.includes("nothing to commit")) {
        console.warn(`[workflow] git commit failed for ${filename}: ${said.slice(0, 200)}`);
      }
      return headHash();
    }
    return headHash();
  }

  function headHash(): string | null {
    if (!gitReady) return null;
    const rev = Bun.spawnSync(["git", "rev-parse", "--short=12", "HEAD"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (rev.exitCode !== 0) return null;
    const out = rev.stdout.toString().trim();
    return out.length > 0 ? out : null;
  }

  return {
    dir: root,
    gitReady,

    filePath(workflowId) {
      return join(root, relFile(workflowId));
    },

    exists(workflowId) {
      return existsSync(join(root, relFile(workflowId)));
    },

    readRaw(workflowId) {
      const abs = join(root, relFile(workflowId));
      if (!existsSync(abs)) return null;
      return readFileSync(abs, "utf8");
    },

    readParsed(workflowId) {
      const raw = this.readRaw(workflowId);
      if (raw === null) return null;
      try {
        return parseWorkflow(JSON.parse(raw));
      } catch {
        return null;
      }
    },

    listIds() {
      if (!existsSync(root)) return [];
      return readdirSync(root)
        .filter((f) => f.endsWith(".workflow.json"))
        .map((f) => f.replace(/\.workflow\.json$/, ""))
        .sort();
    },

    statMtime(workflowId) {
      const abs = join(root, relFile(workflowId));
      if (!existsSync(abs)) return null;
      return Math.round(statSync(abs).mtimeMs);
    },

    write(workflowId, definition, info) {
      const filename = relFile(workflowId);
      const abs = join(root, filename);
      mkdirSync(root, { recursive: true });
      const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, `${JSON.stringify(definition, null, 2)}\n`, "utf8");
      renameSync(tmp, abs);
      return commitFile(filename, info, false);
    },

    remove(workflowId, info) {
      const filename = relFile(workflowId);
      const abs = join(root, filename);
      const existed = existsSync(abs);
      if (!existed) return false;
      rmSync(abs, { force: true });
      commitFile(filename, info, true);
      return true;
    },

    history(workflowId, limit = 20) {
      const filename = relFile(workflowId);
      if (!gitReady) return [];
      const bounded = Math.max(1, Math.min(100, limit));
      const res = Bun.spawnSync(
        ["git", "log", `-n${bounded}`, "--format=%H%x1f%an%x1f%at%x1f%s", "--", filename],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      if (res.exitCode !== 0) return [];
      const entries: WorkflowHistoryEntry[] = [];
      for (const line of res.stdout.toString().split("\n")) {
        if (!line.trim()) continue;
        const [commit, author, ts, summary] = line.split("\x1f");
        if (!commit) continue;
        entries.push({
          commit,
          author: author ?? "unknown",
          timestamp: Number(ts ?? 0) * 1000,
          summary: summary ?? "",
        });
      }
      return entries;
    },

    readAtCommit(workflowId, commitHash) {
      const filename = relFile(workflowId);
      if (!gitReady || !COMMIT_HASH_RE.test(commitHash)) return null;
      const res = Bun.spawnSync(["git", "show", `${commitHash}:${filename}`], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (res.exitCode !== 0) return null;
      return res.stdout.toString();
    },

    revert(workflowId, commitHash, info) {
      if (!COMMIT_HASH_RE.test(commitHash)) {
        throw new Error(`invalid commit hash: ${commitHash}`);
      }
      const raw = this.readAtCommit(workflowId, commitHash);
      if (raw === null) {
        throw new Error(`version ${commitHash} not found for workflow ${workflowId}`);
      }
      const definition = parseWorkflow(JSON.parse(raw));
      const commit = this.write(workflowId, definition, {
        author: info.author,
        summary: info.summary || `revert ${workflowId} to ${commitHash.slice(0, 8)}`,
      });
      return { definition, commit };
    },
  };
}
