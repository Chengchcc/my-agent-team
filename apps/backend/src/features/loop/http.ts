import { rm } from "node:fs/promises";
import type { SessionManager } from "@my-agent-team/harness";
import { loopReducer } from "@my-agent-team/loop";
import { Elysia, t } from "elysia";
import { ulid } from "../../infra/ids.js";
import type { CronJobPort } from "../cron/ports.js";
import type { CronScheduler } from "../cron/scheduler.js";
import type { CronJobService } from "../cron/service.js";
import { resolveLoopPaths } from "../loop/resolve-paths.js";
import type { ProjectPort } from "../project/ports.js";
import type { SettingsService } from "../settings/index.js";
import {
  type BuildConfigFn,
  type ConvPort,
  createLoop,
  getLoopDetail,
  getTodayWork,
  listLoops,
  refineLoop,
  reviewLoop,
  runLoop,
} from "./loop-service.js";
import type { LoopStateStore } from "./loop-state-store.js";

export function loopRoutes(
  cronSvc: CronJobService,
  scheduler: CronScheduler,
  _cronPort: CronJobPort,
  dataDir: string,
  _idGen: () => string,
  sessionManager: SessionManager,
  buildConfig: BuildConfigFn,
  store: LoopStateStore,
  projectPort?: ProjectPort,
  convPort?: ConvPort,
  settingsSvc?: SettingsService,
) {
  return new Elysia()
    .get("/api/loops", () => {
      return { loops: listLoops(cronSvc, store) };
    })
    .get("/api/work/today", () => {
      return { reviewQueue: getTodayWork(cronSvc, store) };
    })
    .get("/api/loops/:id", async ({ params: { id }, set }) => {
      const detail = getLoopDetail(cronSvc, store, id);
      if (!detail) {
        set.status = 404;
        return { error: "Not a loop" };
      }
      return { loop: detail };
    })
    .post(
      "/api/loops",
      async ({ body, set }) => {
        const result = await createLoop(
          {
            cronSvc,
            cronPort: _cronPort,
            scheduler,
            dataDir,
            sessionManager,
            buildConfig,
            convPort,
            settingsSvc,
          },
          {
            name: body.name,
            intent: body.intent,
            projectId: body.projectId,
            cronExpr: body.cronExpr,
          },
        );

        if (result.status === "needs_clarification") {
          set.status = 200;
          return result;
        }
        set.status = 201;
        return result;
      },
      {
        body: t.Object({
          name: t.String(),
          intent: t.Optional(t.String()),
          projectId: t.Optional(t.String()),
          cronExpr: t.Optional(t.String()),
        }),
      },
    )
    .post("/api/loops/:id/activate", async ({ params: { id }, set }) => {
      const job = cronSvc.getById(id);
      if (!job?.loopConfigPath) {
        set.status = 404;
        return { error: "Not a loop" };
      }
      await cronSvc.setEnabled(id, true);
      const updated = cronSvc.getById(id);
      if (updated) scheduler.register(updated);
      return { loop: { id, enabled: true, cronExpr: job.cronExpr } };
    })
    .post(
      "/api/loops/:id/refine",
      async ({ params: { id }, body, set }) => {
        const result = await refineLoop(
          {
            cronSvc,
            cronPort: _cronPort,
            scheduler,
            dataDir,
            sessionManager,
            buildConfig,
          },
          id,
          { intent: body.intent, clarifyRound: body.clarifyRound },
        );
        if (!result) {
          set.status = 404;
          return { error: "Not a loop" };
        }
        return result;
      },
      {
        body: t.Object({
          intent: t.String(),
          clarifyRound: t.Optional(t.Number()),
        }),
      },
    )
    .post("/api/loops/:id/run", async ({ params: { id }, set }) => {
      const state = await runLoop(
        { cronSvc, dataDir, sessionManager, buildConfig, projectPort, store, convPort },
        id,
      );
      if (!state) {
        set.status = 404;
        return { error: "Not a loop" };
      }
      return { state };
    })
    .post(
      "/api/loops/:id/review",
      async ({ params: { id }, body, set }) => {
        const result = await reviewLoop(
          { cronSvc, dataDir, sessionManager, buildConfig, projectPort, store },
          id,
          { itemId: body.itemId, verdict: body.verdict, feedback: body.feedback },
        );
        if (!result) {
          set.status = 404;
          return { error: "Not a loop" };
        }
        return result;
      },
      {
        body: t.Object({
          itemId: t.String(),
          verdict: t.Union([
            t.Literal("approve"),
            t.Literal("reject"),
            t.Literal("promote"),
            t.Literal("retry"),
            t.Literal("dismiss"),
          ]),
          feedback: t.Optional(t.String()),
        }),
      },
    )
    .post(
      "/api/loops/:id/items",
      async ({ params: { id }, body, set }) => {
        const job = cronSvc.getById(id);
        if (!job?.loopConfigPath) {
          set.status = 404;
          return { error: "Not a loop" };
        }
        const state = store.load(id);
        const itemId = ulid();
        const newState = loopReducer(state, {
          type: "ADD_ITEM",
          item: { id: itemId, source: body.source, summary: body.summary },
          priority: body.priority,
        });
        store.save(id, newState, {});
        const item = newState.items[itemId];
        set.status = 201;
        return { item };
      },
      {
        body: t.Object({
          source: t.String({ minLength: 1 }),
          summary: t.String({ minLength: 1 }),
          priority: t.Optional(t.Number()),
        }),
      },
    )
    .delete("/api/loops/:id", async ({ params: { id }, set }) => {
      try {
        const job = cronSvc.getById(id);
        if (!job?.loopConfigPath) {
          set.status = 404;
          return { error: "Not a loop" };
        }
        scheduler.unregister(id);
        cronSvc.remove(id);
        await rm(resolveLoopPaths(job, dataDir).loopConfigPath, { recursive: true, force: true });
        set.status = 204;
        return;
      } catch {
        set.status = 404;
        return { error: "Not found" };
      }
    });
}
