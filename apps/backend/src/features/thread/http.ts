import { z } from "zod";
import { ThreadNotFoundError } from "./service.js";
import { json, parseJsonBody } from "../../http/response.js";

const createSchema = z.object({
  title: z.string().optional(),
  kind: z.enum(["agent_thread", "conversation"]).optional(),
});
const updateSchema = z.object({ title: z.string().optional() });

export function threadRoutes(svc: ReturnType<typeof import("./service.js").createThreadService>) {
  return {
    async create(req: Request, agentId: string): Promise<Response> {
      const body = await parseJsonBody(req);
      if ("error" in body) return body.error;
      const parsed = createSchema.safeParse(body.data);
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);
      try {
        return json(await svc.create(agentId, parsed.data), 201);
      } catch (err) {
        if (err instanceof Error && err.name === "AgentNotFoundForThreadError")
          return json({ error: err.message }, 404);
        throw err;
      }
    },
    async list(_req: Request, agentId: string): Promise<Response> {
      return json(await svc.listByAgent(agentId));
    },
    async getById(_req: Request, id: string): Promise<Response> {
      try {
        return json(await svc.getById(id));
      } catch (err) {
        if (err instanceof ThreadNotFoundError) return json({ error: err.message }, 404);
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
        if (err instanceof ThreadNotFoundError) return json({ error: err.message }, 404);
        throw err;
      }
    },
    async delete(_req: Request, id: string): Promise<Response> {
      try {
        await svc.delete(id);
        return new Response(null, { status: 204 });
      } catch (err) {
        if (err instanceof ThreadNotFoundError) return json({ error: err.message }, 404);
        throw err;
      }
    },
  };
}
