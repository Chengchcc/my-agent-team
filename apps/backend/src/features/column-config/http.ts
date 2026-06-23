import { z } from "zod";
import { json } from "../../http/response.js";
import type { IssueStatus } from "../issue/entities.js";
import { validateTemplate } from "../orchestrator/render.js";
import { configurableStatuses } from "../orchestrator/transitions.js";
import { ColumnConfigNotFoundError, type ColumnConfigService, ValidationError } from "./service.js";

// Only statuses the reactor can auto-advance are configurable. Accepting draft/
// in_review/done would persist orphan configs that transitionsForProject silently
// skips and the editor UI never surfaces. Keep the API in lock-step with the UI.
const upsertSchema = z.object({
  projectId: z.string().trim().min(1),
  status: z.enum(configurableStatuses() as unknown as readonly [string, ...string[]]),
  agentId: z.string().trim().min(1),
  promptTemplate: z.string().trim().min(1),
});

export function columnConfigRoutes(svc: ColumnConfigService) {
  return {
    /** GET /api/column-configs?projectId= → 200 { configs } */
    list(req: Request): Response {
      const projectId = new URL(req.url).searchParams.get("projectId");
      if (!projectId) return json({ error: "projectId required" }, 400);
      return json({ configs: svc.listByProject(projectId) });
    },

    /** POST /api/column-configs → 201 { config } | 400 */
    async upsert(req: Request): Promise<Response> {
      const parsed = upsertSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);
      // M19 Fix 4: Validate Handlebars template at config-write time
      const tmplErr = validateTemplate(parsed.data.promptTemplate);
      if (tmplErr) return json({ error: `Invalid template: ${tmplErr}` }, 400);
      try {
        const config = await svc.upsert({
          ...parsed.data,
          status: parsed.data.status as IssueStatus,
        });
        return json({ config }, 201);
      } catch (err) {
        if (err instanceof ValidationError) return json({ error: err.message }, 400);
        throw err;
      }
    },

    /** DELETE /api/column-configs/:id → 204 | 404 */
    remove(_req: Request, configId: string): Response {
      try {
        svc.remove(configId);
        return new Response(null, { status: 204 });
      } catch (err) {
        if (err instanceof ColumnConfigNotFoundError) return json({ error: err.message }, 404);
        throw err;
      }
    },
  };
}
