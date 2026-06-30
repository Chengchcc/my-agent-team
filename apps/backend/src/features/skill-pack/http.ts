import { Elysia, t } from "elysia";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentFsLike } from "@my-agent-team/tools-common";
import { loadSkillIndexWithMtimeCache } from "@my-agent-team/plugin-progressive-skill";
import { installPath, posixSkillRoot } from "./entities.js";
import { assertSafeEntry } from "./tools.js";
import type { SkillPackService } from "./service.js";
import { BuiltinPackImmutableError } from "./service.js";
import type { SkillPackRow } from "./entities.js";

// ─── Shared FS adapter ────────────────────────────────────────────────────────────

function nodeFsAdapter(cwd: string): AgentFsLike {
  return {
    async read(path: string) {
      try {
        const full = resolve(cwd, path);
        if (!full.startsWith(cwd)) return null;
        return readFileSync(full, "utf-8");
      } catch { return null; }
    },
    async write(path: string, content: string) {
      const full = resolve(cwd, path);
      if (!full.startsWith(cwd)) throw new Error("Path escapes workspace");
      mkdirSync(resolve(full, ".."), { recursive: true });
      writeFileSync(full, content, "utf-8");
    },
    async list(dir: string) {
      try {
        const full = resolve(cwd, dir);
        if (!full.startsWith(cwd)) return [];
        return readdirSync(full, { withFileTypes: true }).map((d) => d.name);
      } catch { return []; }
    },
    async stat(path: string) {
      try {
        const full = resolve(cwd, path);
        if (!full.startsWith(cwd)) return null;
        const s = statSync(full);
        return { mtimeMs: s.mtimeMs, size: s.size };
      } catch { return null; }
    },
    async exists(path: string) {
      try {
        const full = resolve(cwd, path);
        return full.startsWith(cwd) && existsSync(full);
      } catch { return false; }
    },
    async mkdirp(path: string) {
      const full = resolve(cwd, path);
      if (!full.startsWith(cwd)) throw new Error("Path escapes workspace");
      mkdirSync(full, { recursive: true });
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────────

function toPackResponse(row: SkillPackRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceKind: row.sourceKind,
    sourceUrl: row.sourceUrl,
    versionRef: row.versionRef,
    installedRef: row.installedRef,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── Elysia plugin ────────────────────────────────────────────────────────────────

export function skillPackRoutes(svc: SkillPackService, dataDir: string) {
  const listAll = async () => {
    const rows = await svc.port.list();
    return rows.map(toPackResponse);
  };

  return new Elysia()
    .get("/api/skill-packs", listAll)

    .post(
      "/api/skill-packs/git",
      async ({ body, set }) => {
        const row = await svc.installFromGit({
          name: body.name,
          description: body.description,
          url: body.url,
          ref: body.ref,
        });
        set.status = 202;
        return toPackResponse(row);
      },
      {
        body: t.Object({
          name: t.String(),
          description: t.String(),
          url: t.String(),
          ref: t.Optional(t.String()),
        }),
      },
    )

    .post(
      "/api/skill-packs/upload",
      async ({ body, set }) => {
        const file = body.file;
        const buffer = Buffer.from(await file.arrayBuffer());
        const row = await svc.installFromZip({
          name: body.name,
          description: body.description,
          buffer,
        });
        set.status = 202;
        return toPackResponse(row);
      },
      {
        body: t.Object({
          name: t.String(),
          description: t.String(),
          file: t.File(),
        }),
      },
    )

    .post("/api/skill-packs/:id/sync", async ({ params: { id }, set }) => {
      try {
        const row = await svc.syncGit(id);
        set.status = 202;
        return toPackResponse(row);
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    })

    .delete("/api/skill-packs/:id", async ({ params: { id }, set }) => {
      try {
        const dir = installPath(dataDir, id);
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

        await svc.uninstall(id);
        set.status = 204;
        return "";
      } catch (err) {
        if (err instanceof BuiltinPackImmutableError) {
          set.status = 409;
          return { error: err.message };
        }
        set.status = 404;
        return { error: (err as Error).message };
      }
    })

    .get("/api/skill-packs/:id/skills", async ({ params: { id } }) => {
      const ws = nodeFsAdapter(posixSkillRoot(dataDir));
      const skills = await loadSkillIndexWithMtimeCache(ws, [id]);
      return skills.map((s: { name: string; description: string; dir: string }) => ({
        name: s.name,
        description: s.description,
        dir: s.dir,
      }));
    })

    .get(
      "/api/skill-packs/:id/files",
      async ({ params: { id }, query: { path: subpath } }) => {
        try {
          const ws = nodeFsAdapter(posixSkillRoot(dataDir));
          const basePath = subpath ? `${id}/${subpath}` : id;

          // Validate against traversal
          const segments = subpath ? subpath.split("/") : [];
          for (const seg of segments) assertSafeEntry(seg);

          const st = await ws.stat(basePath);
          if (!st) return { error: "Not found" };

          const full = resolve(posixSkillRoot(dataDir), basePath);
          const s = statSync(full);

          if (s.isFile()) {
            const content = await ws.read(basePath);
            return { type: "file", path: subpath ?? "", content: content ?? "" };
          }

          if (s.isDirectory()) {
            const names = await ws.list(basePath);
            const entries = [];
            for (const name of names) {
              const entryPath = subpath ? `${subpath}/${name}` : name;
              try {
                const entryStat = statSync(resolve(posixSkillRoot(dataDir), id, entryPath));
                entries.push({ name, type: entryStat.isDirectory() ? "dir" : "file" });
              } catch {
                entries.push({ name, type: "file" });
              }
            }
            return { type: "dir", path: subpath ?? "", entries };
          }

          return { error: "Not a file or directory" };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
      {
        query: t.Object({
          path: t.Optional(t.String()),
        }),
      },
    );
}
