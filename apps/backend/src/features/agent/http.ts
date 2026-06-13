import { z } from "zod";
import { json, parseJsonBody } from "../../http/response.js";
import type { AgentIdentityStore } from "./identity-store.js";
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

export function agentRoutes(svc: AgentService, identityStore?: AgentIdentityStore) {
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

    /** D11: GET /api/agents/:id/identity — read SOUL.md, USER.md,
     *  memory/MEMORY.md and memory/facts/*.md from runner sharedRoot
     *  (single source of truth after M14.7).
     *  Falls back to empty if identityStore is not configured. */
    async identity(_req: Request, agentId: string): Promise<Response> {
      if (!identityStore) return json({ soul: null, user: null, memories: [] });
      try {
        const data = await identityStore.getIdentity(agentId);
        return json(data);
      } catch (err) {
        if (err instanceof AgentNotFoundError) return json({ error: err.message }, 404);
        throw err;
      }
    },

    /** PUT /api/agents/:id/identity — write SOUL.md and/or USER.md to runner sharedRoot. */
    async updateIdentity(req: Request, agentId: string): Promise<Response> {
      if (!identityStore) return json({ error: "Identity store not available" }, 501);
      try {
        const body = (await req.json().catch(() => ({}))) as {
          soul?: string;
          user?: string;
        };
        await identityStore.updateIdentity(agentId, {
          soul: typeof body.soul === "string" ? body.soul : undefined,
          user: typeof body.user === "string" ? body.user : undefined,
        });
        return json({ ok: true });
      } catch (err) {
        if (err instanceof AgentNotFoundError) return json({ error: err.message }, 404);
        throw err;
      }
    },
  };
}
