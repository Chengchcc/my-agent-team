import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { json, parseJsonBody } from "../../http/response.js";
import type { AgentService } from "./service.js";
import { AgentBusyError, AgentNotFoundError } from "./service.js";

const createSchema = z.object({
  name: z.string().min(1),
  template: z.string().optional(),
  model: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    baseURL: z.string().url().optional(),
  }),
  permissionMode: z.enum(["ask", "auto", "deny"]).optional(),
  maxSteps: z.number().int().positive().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  permissionMode: z.enum(["ask", "auto", "deny"]).optional(),
  maxSteps: z.number().int().positive().optional(),
});

export function agentRoutes(svc: AgentService) {
  // Read workspaceRoot from env (set at startup) for path traversal guard
  const workspaceRoot = process.env.BACKEND_WORKSPACE_ROOT;

  return {
    async create(req: Request): Promise<Response> {
      const body = await parseJsonBody(req);
      if ("error" in body) return body.error;
      const parsed = createSchema.safeParse(body.data);
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);
      const row = await svc.create(parsed.data);
      return json(row, 201);
    },

    async list(_req: Request): Promise<Response> {
      const rows = await svc.list();
      return json(rows);
    },

    async getById(_req: Request, id: string): Promise<Response> {
      try {
        return json(await svc.getById(id));
      } catch (err) {
        if (err instanceof AgentNotFoundError) return json({ error: err.message }, 404);
        throw err;
      }
    },

    async update(req: Request, id: string): Promise<Response> {
      const body = await parseJsonBody(req);
      if ("error" in body) return body.error;
      const parsed = updateSchema.safeParse(body.data);
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);
      try {
        return json(await svc.update(id, parsed.data));
      } catch (err) {
        if (err instanceof AgentNotFoundError) return json({ error: err.message }, 404);
        throw err;
      }
    },

    async archive(req: Request, id: string): Promise<Response> {
      try {
        const url = new URL(req.url);
        const hard = url.searchParams.get("hard");
        if (hard === "true") {
          await svc.hardDelete(id);
          return json({ deleted: true, id });
        }
        return json(await svc.archive(id));
      } catch (err) {
        if (err instanceof AgentNotFoundError) return json({ error: err.message }, 404);
        if (err instanceof AgentBusyError) return json({ error: err.message }, 409);
        throw err;
      }
    },

    /** D11: GET /api/agents/:id/identity — read SOUL.md, USER.md, memory/*.md */
    async identity(_req: Request, agentId: string): Promise<Response> {
      try {
        const agent = await svc.getById(agentId);
        const wsPath = path.resolve(agent.workspacePath);

        // Path traversal guard
        if (workspaceRoot) {
          const resolvedRoot = path.resolve(workspaceRoot);
          if (!wsPath.startsWith(resolvedRoot + path.sep) && wsPath !== resolvedRoot) {
            return json({ error: "Invalid workspace path" }, 500);
          }
        }

        let soul: string | null = null;
        let user: string | null = null;
        const memories: Array<{ date: string; content: string }> = [];

        try {
          soul = await readFile(path.join(wsPath, "SOUL.md"), "utf-8");
        } catch {
          // File doesn't exist — leave null
        }

        try {
          user = await readFile(path.join(wsPath, "USER.md"), "utf-8");
        } catch {
          // File doesn't exist — leave null
        }

        try {
          const memDir = path.join(wsPath, "memory");
          const entries = await readdir(memDir);
          for (const entry of entries) {
            if (!entry.endsWith(".md")) continue;
            // Prevent path traversal
            if (entry.includes("..") || entry.includes("/") || entry.includes("\\")) continue;
            try {
              const content = await readFile(path.join(memDir, entry), "utf-8");
              const dateMatch = entry.match(/^(\d{4}-\d{2}-\d{2})/);
              memories.push({
                date: dateMatch?.[1] ?? "unknown",
                content,
              });
            } catch {
              // Skip unreadable files
            }
          }
        } catch {
          // Memory directory doesn't exist — leave []
        }

        return json({ soul, user, memories });
      } catch (err) {
        if (err instanceof AgentNotFoundError) return json({ error: err.message }, 404);
        throw err;
      }
    },

    /** PUT /api/agents/:id/identity — write SOUL.md and/or USER.md */
    async updateIdentity(req: Request, agentId: string): Promise<Response> {
      try {
        const agent = await svc.getById(agentId);
        const wsPath = path.resolve(agent.workspacePath);
        if (workspaceRoot) {
          const resolvedRoot = path.resolve(workspaceRoot);
          if (!wsPath.startsWith(resolvedRoot + path.sep) && wsPath !== resolvedRoot) {
            return json({ error: "Invalid workspace path" }, 500);
          }
        }
        const body = (await req.json().catch(() => ({}))) as {
          soul?: string;
          user?: string;
        };
        if (typeof body.soul === "string") {
          await writeFile(path.join(wsPath, "SOUL.md"), body.soul, "utf-8");
        }
        if (typeof body.user === "string") {
          await writeFile(path.join(wsPath, "USER.md"), body.user, "utf-8");
        }
        return json({ ok: true });
      } catch (err) {
        if (err instanceof AgentNotFoundError) return json({ error: err.message }, 404);
        throw err;
      }
    },
  };
}
