import { Elysia, t } from "elysia";
import { mkdir } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { parseStateMd } from "@my-agent-team/loop";
import type { CronScheduler } from "../cron/scheduler.js";
import type { CronJobService } from "../cron/service.js";

export function loopRoutes(
  cronSvc: CronJobService,
  scheduler: CronScheduler,
  dataDir: string,
) {
  return new Elysia()
    .get("/api/loops", () => ({
      loops: cronSvc.list().filter((j) => j.loopConfigPath != null),
    }))
    .get("/api/loops/:id", async ({ params: { id }, set }) => {
      const job = cronSvc.getById(id);
      if (!job?.loopConfigPath) {
        set.status = 404;
        return { error: "Not a loop" };
      }

      let lastRun: string | null = null;
      let pendingCount = 0;
      try {
        const state = parseStateMd(
          await Bun.file(`${dataDir}/${job.loopConfigPath}/STATE.md`).text(),
        );
        lastRun = state.lastRun;
        pendingCount = Object.values(state.items).filter(
          (i) => i.step === "awaiting_review",
        ).length;
      } catch {
        // STATE.md not yet created
      }

      return {
        loop: {
          id: job.cronJobId,
          name: job.name,
          cronExpr: job.cronExpr,
          enabled: job.enabled,
          loopConfigPath: job.loopConfigPath,
          lastRun,
          pendingCount,
        },
      };
    })
    .post(
      "/api/loops",
      async ({ body, set }) => {
        const loopName = body.name.trim().toLowerCase().replace(/\s+/g, "-");
        const loopPath = `loops/${loopName}`;
        const dir = `${dataDir}/${loopPath}`;
        await mkdir(`${dir}/skills`, { recursive: true });

        await Bun.write(
          `${dir}/LOOP.md`,
          [
            "---",
            `repo: ${body.repo}`,
            "generator:",
            "  model: claude-sonnet-4",
            '  systemPrompt: ""',
            "evaluator:",
            "  model: claude-opus-4",
            '  systemPrompt: ""',
            'acceptance: ""',
            "safety:",
            "  denylist:",
            "    - .env",
            "    - auth/",
            "  maxRetries: 3",
            "  autoMerge: never",
            "budget:",
            "  dailyCap: 200000",
            "---",
            "",
            `# ${body.name}`,
            "",
            body.intent || "",
          ].join("\n"),
        );

        const job = await cronSvc.createCronJob({
          name: body.name,
          agentId: "loop-agent",
          cronExpr: body.cronExpr ?? "",
          prompt: body.intent || "",
          loopConfigPath: loopPath,
          enabled: !body.paused,
        });

        scheduler.register(job);

        set.status = 201;
        return {
          loop: {
            id: job.cronJobId,
            name: job.name,
            cronExpr: job.cronExpr,
            loopConfigPath: job.loopConfigPath,
          },
        };
      },
      {
        body: t.Object({
          name: t.String(),
          intent: t.Optional(t.String()),
          repo: t.String(),
          cronExpr: t.Optional(t.String()),
          paused: t.Optional(t.Boolean()),
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
        await rm(`${dataDir}/${job.loopConfigPath}`, {
          recursive: true,
          force: true,
        });
        set.status = 204;
        return;
      } catch {
        set.status = 404;
        return { error: "Not found" };
      }
    });
}
