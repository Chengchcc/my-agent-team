import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { EVAL_SUITE_ID_RE, type EvalSuite, parseEvalSuite } from "./domain.js";

export interface EvalSuiteCommitInfo {
  readonly author: string;
  readonly summary: string;
}

export interface EvalSuiteHistoryEntry {
  readonly commit: string;
  readonly author: string;
  readonly timestamp: number;
  readonly summary: string;
}

export interface EvalSuiteStore {
  readonly dir: string;
  readonly gitReady: boolean;
  filePath(suiteId: string): string;
  exists(suiteId: string): boolean;
  listIds(): string[];
  listSuites(): EvalSuite[];
  readRaw(suiteId: string): string | null;
  readParsed(suiteId: string): EvalSuite | null;
  headCommit(suiteId?: string): string | null;
  write(
    suiteId: string,
    suite: unknown,
    commit: EvalSuiteCommitInfo,
  ): {
    suite: EvalSuite;
    commit: string | null;
  };
  remove(suiteId: string, commit: EvalSuiteCommitInfo): boolean;
  history(suiteId: string, limit?: number): EvalSuiteHistoryEntry[];
  readAtCommit(suiteId: string, commitHash: string): string | null;
  revert(
    suiteId: string,
    commitHash: string,
    commit: EvalSuiteCommitInfo,
  ): { suite: EvalSuite; commit: string | null };
}

const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

function validateSuiteId(suiteId: string): string {
  if (!EVAL_SUITE_ID_RE.test(suiteId)) {
    throw new Error(`Invalid eval suite id: ${suiteId}`);
  }
  return suiteId;
}

/** ADR 0085 D4: Git-backed filesystem store for `<dataDir>/evals/*.eval.json`.
 *  Mirrors ADR 0084's `createFsWorkflowStore` — atomic `tmp + rename` writes,
 *  attributable local git commits, history & revert, graceful fallback when
 *  git is unavailable. */
export function createFsEvalSuiteStore(root: string): EvalSuiteStore {
  mkdirSync(root, { recursive: true });
  const gitReady = ensureGitRepo(root);

  function ensureGitRepo(dir: string): boolean {
    if (existsSync(join(dir, ".git"))) return true;
    const init = Bun.spawnSync(["git", "init", "-q"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (init.exitCode !== 0) {
      console.warn(`[evals] git unavailable at ${dir}; suites work, history does not`);
      return false;
    }
    Bun.spawnSync(["git", "config", "user.email", "evals@local"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    Bun.spawnSync(["git", "config", "user.name", "CrewDesk Evals"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    return true;
  }

  function runGit(args: string[]): { ok: boolean; stdout: string } {
    if (!gitReady) return { ok: false, stdout: "" };
    const proc = Bun.spawnSync(["git", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      ok: proc.exitCode === 0,
      stdout: proc.stdout.toString("utf8").trim(),
    };
  }

  function fileName(suiteId: string): string {
    return `${validateSuiteId(suiteId)}.eval.json`;
  }

  function filePath(suiteId: string): string {
    return join(root, fileName(suiteId));
  }

  function commitFile(name: string, info: EvalSuiteCommitInfo): string | null {
    if (!gitReady) return null;
    runGit(["add", "--", name]);
    const status = runGit(["status", "--porcelain", "--", name]);
    if (!status.stdout) return headCommit();
    const author = `${info.author.replace(/[<>]/g, "")} <evals@local>`;
    const res = runGit(["commit", "--author", author, "-m", info.summary, "--", name]);
    if (!res.ok) return null;
    return headCommit();
  }

  function headCommit(suiteId?: string): string | null {
    if (!gitReady) return null;
    const args = suiteId
      ? ["log", "-n", "1", "--format=%H", "--", fileName(suiteId)]
      : ["rev-parse", "HEAD"];
    const res = runGit(args);
    return res.ok && res.stdout ? res.stdout : null;
  }

  function listIds(): string[] {
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((f) => f.endsWith(".eval.json"))
      .map((f) => f.slice(0, -".eval.json".length))
      .filter((id) => EVAL_SUITE_ID_RE.test(id))
      .sort();
  }

  function readRaw(suiteId: string): string | null {
    const p = filePath(suiteId);
    if (!existsSync(p)) return null;
    return readFileSync(p, "utf8");
  }

  function readParsed(suiteId: string): EvalSuite | null {
    const raw = readRaw(suiteId);
    if (raw === null) return null;
    try {
      return parseEvalSuite(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  function write(
    suiteId: string,
    rawSuite: unknown,
    commit: EvalSuiteCommitInfo,
  ): { suite: EvalSuite; commit: string | null } {
    validateSuiteId(suiteId);
    const normalized =
      rawSuite && typeof rawSuite === "object"
        ? { ...(rawSuite as Record<string, unknown>), id: suiteId }
        : rawSuite;
    const suite = parseEvalSuite(normalized);
    const target = filePath(suiteId);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(suite, null, 2)}\n`, "utf8");
    renameSync(tmp, target);
    const hash = commitFile(fileName(suiteId), commit);
    return { suite, commit: hash };
  }

  function remove(suiteId: string, commit: EvalSuiteCommitInfo): boolean {
    const target = filePath(suiteId);
    if (!existsSync(target)) return false;
    rmSync(target, { force: true });
    commitFile(fileName(suiteId), commit);
    return true;
  }

  function history(suiteId: string, limit = 20): EvalSuiteHistoryEntry[] {
    if (!gitReady) return [];
    const name = fileName(suiteId);
    const res = runGit([
      "log",
      `-n`,
      String(Math.min(Math.max(1, limit), 100)),
      "--format=%H\t%an\t%at\t%s",
      "--",
      name,
    ]);
    if (!res.ok || !res.stdout) return [];
    return res.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [commit = "", author = "", ts = "0", ...rest] = line.split("\t");
        return {
          commit,
          author,
          timestamp: Number(ts) * 1000,
          summary: rest.join("\t"),
        };
      });
  }

  function readAtCommit(suiteId: string, commitHash: string): string | null {
    if (!gitReady || !COMMIT_HASH_RE.test(commitHash)) return null;
    const res = runGit(["show", `${commitHash}:${fileName(suiteId)}`]);
    return res.ok && res.stdout ? res.stdout : null;
  }

  function revert(
    suiteId: string,
    commitHash: string,
    commit: EvalSuiteCommitInfo,
  ): { suite: EvalSuite; commit: string | null } {
    const raw = readAtCommit(suiteId, commitHash);
    if (!raw) throw new Error(`Commit ${commitHash} not found for suite ${suiteId}`);
    return write(suiteId, JSON.parse(raw), commit);
  }

  return {
    dir: root,
    gitReady,
    filePath,
    exists: (suiteId) => existsSync(filePath(suiteId)),
    listIds,
    listSuites: () =>
      listIds()
        .map((id) => readParsed(id))
        .filter((s): s is EvalSuite => s !== null),
    readRaw,
    readParsed,
    headCommit,
    write,
    remove,
    history,
    readAtCommit,
    revert,
  };
}
