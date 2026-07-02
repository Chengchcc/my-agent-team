import { mkdir, rm } from "node:fs/promises";
import { parseStateMd } from "@my-agent-team/loop";
import { Elysia, t } from "elysia";
import type { CronJobPort } from "../cron/ports.js";
import type { CronScheduler } from "../cron/scheduler.js";
import type { CronJobService } from "../cron/service.js";
import { loopStep } from "../loop/loop-step.js";
import type { SessionFactory, SessionSpec } from "../span/session-factory.js";

export function loopRoutes(
  cronSvc: CronJobService,
  scheduler: CronScheduler,
  _cronPort: CronJobPort,
  dataDir: string,
  idGen: () => string,
  sessionFactory: SessionFactory,
  buildSpec: (params: { sessionId: string; modelName: string; cwd: string }) => SessionSpec,
  convPort?: {
    createConversation: (input: {
      conversationId: string;
      title?: string;
      origin?: string;
      createdAt: number;
    }) => unknown;
    addMember: (input: {
      conversationId: string;
      memberId: string;
      kind: "agent" | "human";
      agentId?: string;
      joinedAt: number;
    }) => unknown;
  },
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
        const loopId = idGen();

        // 1. Create cron_job row
        const job = await cronSvc.createCronJob({
          name: body.name,
          agentId: "loop-agent",
          cronExpr: body.cronExpr ?? "",
          prompt: body.intent || "",
          loopConfigPath: loopPath,
          enabled: true,
        });

        // 2. Create Conversation
        try {
          convPort?.createConversation({
            conversationId: job.cronJobId,
            title: body.name,
            origin: "loop",
            createdAt: Date.now(),
          });
          convPort?.addMember({
            conversationId: job.cronJobId,
            memberId: "owner",
            kind: "agent",
            agentId: "loop-agent",
            joinedAt: Date.now(),
          });
        } catch {
          // best-effort
        }

        // 3. Create directory
        await mkdir(`${dir}/skills`, { recursive: true });

        // 4. Copy runtime skill templates
        for (const skill of ["loop-triage", "loop-generator", "loop-verifier"]) {
          const src = `${dataDir}/skill-packs/loop-engine/${skill}/SKILL.md`;
          const dst = `${dir}/skills/${skill}/SKILL.md`;
          try {
            await mkdir(`${dir}/skills/${skill}`, { recursive: true });
            await Bun.write(dst, await Bun.file(src).text());
          } catch {
            // template unavailable
          }
        }

        // 5. If intent provided, run AgentSession to generate LOOP.md
        if (body.intent) {
          const sessionId = `loop:create:${loopId}`;
          const spec = buildSpec({
            sessionId,
            modelName: "claude-sonnet-4",
            cwd: dir,
          });

          const registryPath = `${dataDir}/skill-packs/loop-engine/registry.yaml`;
          const intent = `Create a Loop configuration based on this intent: "${body.intent}"

Target directory: ${dir}
Registry is at: ${registryPath}

Steps:
1. Use the write tool to create ${dir}/LOOP.md with the appropriate frontmatter
2. Use the write tool to copy skill templates from ${dataDir}/skill-packs/loop-engine/ to ${dir}/skills/
3. If the loop has a schedule, use the update_loop_config tool to set the cron expression`;

          sessionFactory.getOrCreate(sessionId, spec);
          await sessionFactory.enqueuePrompt(sessionId, intent);
          sessionFactory.dispose(sessionId);
        } else {
          await Bun.write(
            `${dir}/LOOP.md`,
            [
              "---",
              `projectId: ${body.projectId ?? ""}`,
              "generator:",
              "  model: claude-sonnet-4",
              '  systemPrompt: ""',
              "evaluator:",
              "  model: claude-opus-4",
              '  systemPrompt: ""',
              'acceptance: ""',
              "---",
              "",
              `# ${body.name}`,
            ].join("\n"),
          );
        }

        // 6. Register scheduler
        scheduler.register(job);

        // 7. Read LOOP.md for preview
        let preview = "";
        try {
          preview = await Bun.file(`${dir}/LOOP.md`).text();
        } catch {}

        set.status = 201;
        return {
          loop: {
            id: job.cronJobId,
            name: job.name,
            cronExpr: job.cronExpr,
            loopConfigPath: job.loopConfigPath,
            preview,
          },
        };
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
    .post("/api/loops/:id/run", async ({ params: { id }, set }) => {
      const job = cronSvc.getById(id);
      if (!job?.loopConfigPath) {
        set.status = 404;
        return { error: "Not a loop" };
      }

      const state = await loopStep({
        loopConfigPath: `${dataDir}/${job.loopConfigPath}`,
        sessionFactory,
        buildSpec,
      });

      return { state };
    })
    .post(
      "/api/loops/:id/review",
      async ({ params: { id }, body, set }) => {
        const job = cronSvc.getById(id);
        if (!job?.loopConfigPath) {
          set.status = 404;
          return { error: "Not a loop" };
        }

        const state = await loopStep({
          loopConfigPath: `${dataDir}/${job.loopConfigPath}`,
          sessionFactory,
          buildSpec,
          action: {
            itemId: body.itemId,
            verdict: body.verdict,
            feedback: body.feedback,
          },
        });

        return { state };
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
    .delete("/api/loops/:id", async ({ params: { id }, set }) => {
      try {
        const job = cronSvc.getById(id);
        if (!job?.loopConfigPath) {
          set.status = 404;
          return { error: "Not a loop" };
        }
        scheduler.unregister(id);
        cronSvc.remove(id);
        await rm(`${dataDir}/${job.loopConfigPath}`, { recursive: true, force: true });
        set.status = 204;
        return;
      } catch {
        set.status = 404;
        return { error: "Not found" };
      }
    });
}
