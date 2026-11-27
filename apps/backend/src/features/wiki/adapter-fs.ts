import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** The filesystem half of the wiki: a directory that happens to be a git
 *  repository. Git is the version control (human edits are ordinary commits,
 *  automatic upkeep is a commit with an author) — when git is unavailable the
 *  wiki still works, minus history, and says so once. */
export interface WikiStore {
  read(relPath: string): string | null;
  write(relPath: string, content: string, commit: { author: string; summary: string }): void;
  /** Recursive, root-relative, sorted. */
  list(relDir: string): string[];
}

export function createFsWikiStore(root: string): WikiStore {
  const dirs = [
    "raw/conversations",
    "raw/files",
    "personal",
    "projects",
    "decisions",
    "concepts",
    "lessons",
  ];
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
  const gitReady = ensureGitRepo(root);

  function ensureGitRepo(dir: string): boolean {
    if (existsSync(join(dir, ".git"))) return true;
    const init = Bun.spawnSync(["git", "init", "-q"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (init.exitCode !== 0) {
      console.warn(`[wiki] git unavailable at ${dir}; pages work, history does not`);
      return false;
    }
    // A local identity makes every commit attributable without touching the
    // host's global config.
    Bun.spawnSync(["git", "config", "user.email", "wiki@local"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    Bun.spawnSync(["git", "config", "user.name", "wiki"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    return true;
  }

  function commit(relPath: string, info: { author: string; summary: string }): void {
    if (!gitReady) return;
    const add = Bun.spawnSync(["git", "add", "--", relPath], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (add.exitCode !== 0) {
      console.warn(`[wiki] git add failed for ${relPath}`);
      return;
    }
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: info.author,
      GIT_AUTHOR_EMAIL: "agent@local",
      GIT_COMMITTER_NAME: info.author,
      GIT_COMMITTER_EMAIL: "agent@local",
    };
    const res = Bun.spawnSync(
      ["git", "commit", "-q", "-m", `${info.summary} [${info.author}]`, "--", relPath],
      {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (res.exitCode !== 0) {
      // git prints "nothing to commit" on STDOUT (stderr stays empty) — an
      // unchanged page is normal; anything else is worth a line.
      const said = `${res.stdout.toString()}${res.stderr.toString()}`;
      if (!said.includes("nothing to commit")) {
        console.warn(`[wiki] git commit failed for ${relPath}: ${said.slice(0, 200)}`);
      }
    }
  }

  const realRoot = realpathSync(root);

  /** Resolve `relPath` strictly inside `realRoot`, rejecting traversal, null
   *  bytes, `.git` access, and any symlink along existing segments. */
  function safeResolve(relPath: string, opts?: { allowRoot?: boolean }): string {
    if (relPath.includes("\0")) {
      throw new Error(`invalid wiki path: ${relPath}`);
    }
    const normalized = relPath.replace(/\\/g, "/");
    const segments = normalized.split("/").filter((s) => s.length > 0);
    if (segments.some((s) => s === "." || s === ".." || s === ".git")) {
      throw new Error(`wiki path escapes root: ${relPath}`);
    }
    const abs = resolve(realRoot, ...segments);
    if (abs === realRoot) {
      if (opts?.allowRoot) return realRoot;
      throw new Error(`wiki path must name a file inside root: ${relPath}`);
    }
    if (!abs.startsWith(`${realRoot}${sep}`)) {
      throw new Error(`wiki path escapes root: ${relPath}`);
    }
    // Check every existing prefix segment for symlinks and realpath containment.
    let cur = realRoot;
    for (const seg of segments) {
      cur = join(cur, seg);
      if (!existsSync(cur)) break;
      const st = lstatSync(cur);
      if (st.isSymbolicLink()) {
        throw new Error(`symlinks are not allowed in wiki path: ${relPath}`);
      }
      const real = realpathSync(cur);
      if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) {
        throw new Error(`wiki path escapes root via symlink: ${relPath}`);
      }
    }
    return abs;
  }

  return {
    read(relPath) {
      const abs = safeResolve(relPath);
      if (!existsSync(abs)) return null;
      return readFileSync(abs, "utf8");
    },
    write(relPath, content, info) {
      const abs = safeResolve(relPath);
      mkdirSync(dirname(abs), { recursive: true });
      // Re-verify after mkdirSync in case of concurrent symlink creation.
      const realDir = realpathSync(dirname(abs));
      if (realDir !== realRoot && !realDir.startsWith(`${realRoot}${sep}`)) {
        throw new Error(`wiki path escapes root: ${relPath}`);
      }
      // Temp + rename: a reader never sees half a page, and a crashed write
      // leaves the previous version intact.
      const tmp = `${abs}.tmp-${process.pid}`;
      writeFileSync(tmp, content, "utf8");
      renameSync(tmp, abs);
      commit(relPath, info);
    },
    list(relDir) {
      const out: string[] = [];
      const walk = (rel: string) => {
        const abs = safeResolve(rel, { allowRoot: true });
        if (!existsSync(abs)) return;
        for (const entry of readdirSync(abs, { withFileTypes: true })) {
          if (entry.name === ".git" || entry.isSymbolicLink()) continue;
          const child = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(child);
          else out.push(child);
        }
      };
      walk(relDir);
      return out.sort();
    },
  };
}
