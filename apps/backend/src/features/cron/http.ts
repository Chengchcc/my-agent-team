import { z } from "zod";
import { json } from "../../http/response.js";
import type { CronScheduler } from "./scheduler.js";
import { CronJobNotFoundError, type CronJobService, CronJobValidationError } from "./service.js";

const cronExprField = z
  .string()
  .trim()
  .regex(/^(\S+\s+){4}\S+$/, "cron expression must have 5 fields");

const createSchema = z.object({
  name: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  cronExpr: cronExprField,
  prompt: z.string().optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  enabled: z.boolean().optional(),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    agentId: z.string().trim().min(1).optional(),
    cronExpr: cronExprField.optional(),
    prompt: z.string().optional(),
    timeoutMs: z.number().int().nonnegative().optional(),
    maxRetries: z.number().int().nonnegative().optional(),
  })
  .strict();

const enableSchema = z.object({ enabled: z.boolean() });

export function cronJobRoutes(svc: CronJobService, scheduler: CronScheduler) {
  return {
    /** GET /api/cron-jobs → 200 { cronJobs } */
    list(_req: Request): Response {
      return json({ cronJobs: svc.list() });
    },

    /** GET /api/cron-jobs/:id → 200 { cronJob } | 404 */
    get(_req: Request, id: string): Response {
      try {
        return json({ cronJob: svc.getById(id) });
      } catch (e) {
        if (e instanceof CronJobNotFoundError) return json({ error: e.message }, 404);
        throw e;
      }
    },

    /** POST /api/cron-jobs → 201 { cronJob } | 400 */
    async create(req: Request): Promise<Response> {
      const p = createSchema.safeParse(await req.json().catch(() => ({})));
      if (!p.success) return json({ error: "Validation failed", details: p.error.issues }, 400);
      try {
        const job = await svc.createCronJob(p.data);
        scheduler.register(job);
        return json({ cronJob: job }, 201);
      } catch (e) {
        if (e instanceof CronJobValidationError) return json({ error: e.message }, 400);
        throw e;
      }
    },

    /** PATCH /api/cron-jobs/:id → 200 { cronJob } | 400 | 404 */
    async update(req: Request, id: string): Promise<Response> {
      const p = updateSchema.safeParse(await req.json().catch(() => ({})));
      if (!p.success) return json({ error: "Validation failed", details: p.error.issues }, 400);
      try {
        const job = await svc.update(id, p.data);
        scheduler.register(job); // re-register in case expression changed
        return json({ cronJob: job });
      } catch (e) {
        if (e instanceof CronJobNotFoundError) return json({ error: e.message }, 404);
        if (e instanceof CronJobValidationError) return json({ error: e.message }, 400);
        throw e;
      }
    },

    /** POST /api/cron-jobs/:id/enable → 200 { cronJob } | 400 | 404 */
    async setEnabled(req: Request, id: string): Promise<Response> {
      const p = enableSchema.safeParse(await req.json().catch(() => ({})));
      if (!p.success) return json({ error: "Validation failed", details: p.error.issues }, 400);
      try {
        const job = svc.setEnabled(id, p.data.enabled);
        scheduler.register(job); // register handles enable/disable internally
        return json({ cronJob: job });
      } catch (e) {
        if (e instanceof CronJobNotFoundError) return json({ error: e.message }, 404);
        throw e;
      }
    },

    /** DELETE /api/cron-jobs/:id → 204 | 404 */
    remove(_req: Request, id: string): Response {
      try {
        svc.remove(id);
        scheduler.unregister(id);
        return new Response(null, { status: 204 });
      } catch (e) {
        if (e instanceof CronJobNotFoundError) return json({ error: e.message }, 404);
        throw e;
      }
    },
  };
}
