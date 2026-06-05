import { z } from "zod";
import type { AgentService } from "./service.js";
import { AgentNotFoundError } from "./service.js";

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readBody(req: Request): Promise<unknown> {
  try { return await req.json(); } catch { return {}; }
}

export function agentRoutes(svc: AgentService) {
  return {
    async create(req: Request): Promise<Response> {
      const parsed = createSchema.safeParse(await readBody(req));
      if (!parsed.success) return json({ error: "Validation failed", details: parsed.error.issues }, 400);
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
      const parsed = updateSchema.safeParse(await readBody(req));
      if (!parsed.success) return json({ error: "Validation failed", details: parsed.error.issues }, 400);
      try {
        return json(await svc.update(id, parsed.data));
      } catch (err) {
        if (err instanceof AgentNotFoundError) return json({ error: err.message }, 404);
        throw err;
      }
    },

    async archive(_req: Request, id: string): Promise<Response> {
      try {
        return json(await svc.archive(id));
      } catch (err) {
        if (err instanceof AgentNotFoundError) return json({ error: err.message }, 404);
        throw err;
      }
    },
  };
}
