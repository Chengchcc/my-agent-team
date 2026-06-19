import { z } from "zod";
import { json } from "../../http/response.js";
import { ProjectInUseError, ProjectNotFoundError, type ProjectService, ValidationError } from "./service.js";

const createSchema = z.object({
  name: z.string().trim().min(1),
  repoUrl: z.string().trim().optional(),
  defaultBranch: z.string().trim().optional(),
});

const updateSchema = z.object({
  name: z.string().trim().optional(),
  repoUrl: z.string().trim().optional(),
  defaultBranch: z.string().trim().optional(),
});

export function projectRoutes(svc: ProjectService) {
  return {
    /** GET /api/projects → 200 { projects } */
    list(_req: Request): Response {
      return json({ projects: svc.list() });
    },

    /** POST /api/projects → 201 { project } | 400 */
    async create(req: Request): Promise<Response> {
      const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);
      try {
        const project = svc.createProject(parsed.data);
        return json({ project }, 201);
      } catch (err) {
        if (err instanceof ValidationError) return json({ error: err.message }, 400);
        throw err;
      }
    },

    /** GET /api/projects/:id → 200 { project } | 404 */
    get(_req: Request, id: string): Response {
      try {
        return json({ project: svc.getById(id) });
      } catch (err) {
        if (err instanceof ProjectNotFoundError) return json({ error: err.message }, 404);
        throw err;
      }
    },

    /** PATCH /api/projects/:id → 200 { project } | 400 | 404 */
    async update(req: Request, id: string): Promise<Response> {
      const parsed = updateSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);
      try {
        const project = svc.update(id, parsed.data);
        return json({ project });
      } catch (err) {
        if (err instanceof ProjectNotFoundError) return json({ error: err.message }, 404);
        if (err instanceof ValidationError) return json({ error: err.message }, 400);
        throw err;
      }
    },

    /** DELETE /api/projects/:id → 204 | 404 | 409 */
    remove(_req: Request, id: string): Response {
      try {
        svc.remove(id);
        return new Response(null, { status: 204 });
      } catch (err) {
        if (err instanceof ProjectInUseError) return json({ error: err.message }, 409);
        if (err instanceof ProjectNotFoundError) return json({ error: err.message }, 404);
        throw err;
      }
    },
  };
}
