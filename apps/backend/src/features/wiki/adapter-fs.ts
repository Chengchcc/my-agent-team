import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

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

  return {
    read(relPath) {
      const abs = join(root, relPath);
      if (!existsSync(abs)) return null;
      return readFileSync(abs, "utf8");
    },
    write(relPath, content, info) {
      const abs = join(root, relPath);
      mkdirSync(dirname(abs), { recursive: true });
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
        const abs = join(root, rel);
        if (!existsSync(abs)) return;
        for (const entry of readdirSync(abs, { withFileTypes: true })) {
          if (entry.name === ".git") continue;
          const child = `${rel}/${entry.name}`;
          if (entry.isDirectory()) walk(child);
          else out.push(child);
        }
      };
      walk(relDir);
      return out.sort();
    },
  };
}
