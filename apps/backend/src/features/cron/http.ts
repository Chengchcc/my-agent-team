import { Elysia, t } from "elysia";
import type { CronScheduler } from "./scheduler.js";
import { CronJobNotFoundError, type CronJobService, CronJobValidationError } from "./service.js";

export function cronJobRoutes(svc: CronJobService, scheduler: CronScheduler) {
  return new Elysia()
    .get(
      "/api/cron-jobs",
      ({ query }) => {
        const jobs = svc.list();
        if (query.kind === "loop")
          return { cronJobs: jobs.filter((j) => j.loopConfigPath != null) };
        if (query.kind === "cron")
          return { cronJobs: jobs.filter((j) => j.loopConfigPath == null) };
        return { cronJobs: jobs };
      },
      {
        query: t.Object({
          kind: t.Optional(t.Union([t.Literal("cron"), t.Literal("loop")])),
        }),
      },
    )
    .get("/api/cron-jobs/:id", ({ params: { id } }) => {
      try {
        return { cronJob: svc.getById(id) };
      } catch (e) {
        if (e instanceof CronJobNotFoundError)
          return Response.json({ error: e.message }, { status: 404 });
        throw e;
      }
    })
    .post(
      "/api/cron-jobs",
      async ({ body, set }) => {
        try {
          const job = await svc.createCronJob(body);
          scheduler.register(job);
          set.status = 201;
          return { cronJob: job };
        } catch (e) {
          if (e instanceof CronJobValidationError)
            return Response.json({ error: e.message }, { status: 400 });
          throw e;
        }
      },
      {
        body: t.Object({
          name: t.String({ minLength: 1 }),
          agentId: t.String({ minLength: 1 }),
          cronExpr: t.String({ minLength: 1 }),
          prompt: t.Optional(t.String()),
          timeoutMs: t.Optional(t.Integer({ minimum: 0 })),
          maxRetries: t.Optional(t.Integer({ minimum: 0 })),
          enabled: t.Optional(t.Boolean()),
        }),
      },
    )
    .patch(
      "/api/cron-jobs/:id",
      async ({ params: { id }, body }) => {
        try {
          const job = await svc.update(id, body);
          scheduler.register(job);
          return { cronJob: job };
        } catch (e) {
          if (e instanceof CronJobNotFoundError)
            return Response.json({ error: e.message }, { status: 404 });
          if (e instanceof CronJobValidationError)
            return Response.json({ error: e.message }, { status: 400 });
          throw e;
        }
      },
      {
        body: t.Object({
          name: t.Optional(t.String({ minLength: 1 })),
          agentId: t.Optional(t.String({ minLength: 1 })),
          cronExpr: t.Optional(t.String({ minLength: 1 })),
          prompt: t.Optional(t.String()),
          timeoutMs: t.Optional(t.Integer({ minimum: 0 })),
          maxRetries: t.Optional(t.Integer({ minimum: 0 })),
        }),
      },
    )
    .post(
      "/api/cron-jobs/:id/enable",
      ({ params: { id }, body }) => {
        try {
          const job = svc.setEnabled(id, body.enabled);
          scheduler.register(job);
          return { cronJob: job };
        } catch (e) {
          if (e instanceof CronJobNotFoundError)
            return Response.json({ error: e.message }, { status: 404 });
          throw e;
        }
      },
      {
        body: t.Object({
          enabled: t.Boolean(),
        }),
      },
    )
    .delete("/api/cron-jobs/:id", ({ params: { id }, set }) => {
      try {
        svc.remove(id);
        scheduler.unregister(id);
        set.status = 204;
        return "";
      } catch (e) {
        if (e instanceof CronJobNotFoundError)
          return Response.json({ error: e.message }, { status: 404 });
        throw e;
      }
    });
}
