import { mkdir, rm } from "node:fs/promises";
import type { SessionConfig } from "@my-agent-team/harness";
import { loopReducer } from "@my-agent-team/loop";
import { Elysia, t } from "elysia";
import { ulid } from "../../infra/ids.js";
import type { AppendLedgerInput } from "../conversation/ports.js";
import type { CronJobPort } from "../cron/ports.js";
import type { CronScheduler } from "../cron/scheduler.js";
import type { CronJobService } from "../cron/service.js";
import { loopStep } from "../loop/loop-step.js";
import { resolveLoopPaths } from "../loop/resolve-paths.js";
import type { ProjectPort } from "../project/ports.js";
import type { SettingsService } from "../settings/index.js";
import { nodeFsAdapter } from "../skill-pack/fs-adapter.js";
import type { SessionManager } from "../span/session-manager.js";
import type { SkillRoots } from "../span/skill-roots.js";
import type { LoopStateStore } from "./loop-state-store.js";
import { createUpdateLoopConfigTool } from "./tools.js";

export function loopRoutes(
  cronSvc: CronJobService,
  scheduler: CronScheduler,
  _cronPort: CronJobPort,
  dataDir: string,
  _idGen: () => string,
  sessionManager: SessionManager,
  buildConfig: (params: {
    modelName: string;
    cwd: string;
    skillRoots?: SkillRoots;
  }) => SessionConfig,
  store: LoopStateStore,
  projectPort?: ProjectPort,
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
    appendLedgerEntry: (input: AppendLedgerInput) => unknown;
  },
  settingsSvc?: SettingsService,
) {
  return new Elysia()
    .get("/api/loops", () => {
      const loops = cronSvc
        .list()
        .filter((j) => j.loopConfigPath != null)
        .map((j) => ({
          ...j,
          pendingCount: Object.values(store.load(j.cronJobId).items).filter(
            (i) => i.step === "awaiting_review",
          ).length,
        }));
      return { loops };
    })
    .get("/api/work/today", async () => {
      const loops = cronSvc.list().filter((j) => j.loopConfigPath != null);
      const reviewQueue = [];
      for (const loop of loops) {
        const state = store.load(loop.cronJobId);
        for (const item of Object.values(state.items)) {
          if (item.step === "awaiting_review") {
            reviewQueue.push({ ...item, loopId: loop.cronJobId, loopName: loop.name });
          }
        }
      }
      return { reviewQueue };
    })
    .get("/api/loops/:id", async ({ params: { id }, set }) => {
      const job = cronSvc.getById(id);
      if (!job?.loopConfigPath) {
        set.status = 404;
        return { error: "Not a loop" };
      }

      const state = store.load(id);
      const items = Object.values(state.items).map((i) => ({
        id: i.id,
        source: i.source,
        summary: i.summary,
        step: i.step,
        attempt: i.attempt,
        priority: i.priority,
        result: i.result ?? null,
        generatorSpanId: i.generatorSpanId ?? null,
      }));
      const pendingCount = items.filter((i) => i.step === "awaiting_review").length;

      return {
        loop: {
          id: job.cronJobId,
          name: job.name,
          cronExpr: job.cronExpr,
          enabled: job.enabled,
          loopConfigPath: job.loopConfigPath,
          lastRun: state.lastRun,
          pendingCount,
          items,
          budgetHistory: store.getBudgetHistory(id),
        },
      };
    })
    .post(
      "/api/loops",
      async ({ body, set }) => {
        const loopName = body.name.trim().toLowerCase().replace(/\s+/g, "-");
        const loopPath = `loops/${loopName}`;
        const dir = `${dataDir}/${loopPath}`;

        // 1. Create cron_job row
        const job = await cronSvc.createCronJob({
          name: body.name,
          agentId: "loop-agent",
          cronExpr: body.cronExpr ?? "",
          prompt: body.intent || "",
          loopConfigPath: loopPath,
          enabled: false,
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
          const config = buildConfig({
            modelName: "claude-sonnet-4",
            cwd: dir,
            skillRoots: {
              ws: nodeFsAdapter(`${dir}/skills`),
              roots: ["loop-config-generator"],
              posixSkillRoot: `${dir}/skills`,
            },
          });

          // Inject update_loop_config tool so the agent can set the schedule
          const loopConfigTool = createUpdateLoopConfigTool(job.cronJobId, _cronPort, scheduler);
          const tools = [...(config.tools ?? []), loopConfigTool];
          (config as { tools: typeof tools }).tools = tools;

          const registryPath = `${dataDir}/skill-packs/loop-engine/registry.yaml`;
          const intent = `Create a Loop configuration based on this intent: "${body.intent}"

Target directory: ${dir}
Registry is at: ${registryPath}

Steps:
1. Use the write tool to create ${dir}/LOOP.md with the appropriate frontmatter
2. Use the write tool to copy skill templates from ${dataDir}/skill-packs/loop-engine/ to ${dir}/skills/
3. If the loop has a schedule, use the update_loop_config tool to set the cron expression`;

          const session = sessionManager.create(config);
          await session.prompt(intent);
          sessionManager.dispose(session.sessionId ?? "");
        } else {
          const genModel = settingsSvc?.get<string>("loop.generatorModel") ?? "claude-sonnet-4";
          const evalModel = settingsSvc?.get<string>("loop.evaluatorModel") ?? "claude-opus-4";
          const acceptance = settingsSvc?.get<string>("loop.defaultAcceptance") ?? "";
          const dailyCap = settingsSvc?.get<number>("loop.defaultDailyCap") ?? 200000;
          const denylist = settingsSvc?.get<string[]>("loop.defaultDenylist") ?? [
            ".env",
            "auth/",
            "payments/",
            "secrets/",
          ];

          const denylistYaml = denylist.map((d) => `        - ${d}`).join("\n");
          await Bun.write(
            `${dir}/LOOP.md`,
            [
              "---",
              `projectId: ${body.projectId ?? ""}`,
              "generator:",
              `  model: ${genModel}`,
              '  systemPrompt: ""',
              "evaluator:",
              `  model: ${evalModel}`,
              '  systemPrompt: ""',
              `acceptance: "${acceptance}"`,
              "safety:",
              "  denylist:",
              denylistYaml,
              "  maxRetries: 3",
              "  autoMerge: never",
              "budget:",
              `  dailyCap: ${dailyCap}`,
              "---",
              "",
              `# ${body.name}`,
            ].join("\n"),
          );
        }

        // 6. Check for clarification request first
        let clarifyContent: string | null = null;
        try {
          clarifyContent = await Bun.file(`${dir}/.clarify.json`).text();
        } catch {
          // No clarify file — check LOOP.md
        }

        if (clarifyContent) {
          const clarify = JSON.parse(clarifyContent) as { questions: string[] };
          set.status = 200;
          return {
            status: "needs_clarification",
            loopId: job.cronJobId,
            questions: clarify.questions,
          };
        }

        // Read generated LOOP.md for preview
        let preview = "";
        try {
          preview = await Bun.file(`${dir}/LOOP.md`).text();
        } catch {
          // LOOP.md may not exist yet — preview stays empty
        }

        set.status = 201;
        return {
          status: "generated",
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
        const job = cronSvc.getById(id);
        if (!job?.loopConfigPath) {
          set.status = 404;
          return { error: "Not a loop" };
        }
        const dir = `${dataDir}/${job.loopConfigPath}`;

        // Clean old artifacts
        try {
          await rm(`${dir}/.clarify.json`);
        } catch {
          // file may not exist — ignore
        }
        try {
          await rm(`${dir}/LOOP.md`);
        } catch {
          // file may not exist — ignore
        }

        // Re-run generation with refined intent (same logic as create)
        const config = buildConfig({
          modelName: "claude-sonnet-4",
          cwd: dir,
          skillRoots: {
            ws: nodeFsAdapter(`${dir}/skills`),
            roots: ["loop-config-generator"],
            posixSkillRoot: `${dir}/skills`,
          },
        });

        const loopConfigTool = createUpdateLoopConfigTool(job.cronJobId, _cronPort, scheduler);
        const tools = [...(config.tools ?? []), loopConfigTool];
        (config as { tools: typeof tools }).tools = tools;

        const registryPath = `${dataDir}/skill-packs/loop-engine/registry.yaml`;
        const intent = `Create a Loop configuration based on this intent: "${body.intent}"

Target directory: ${dir}
Registry is at: ${registryPath}

Steps:
1. Use the write tool to create ${dir}/LOOP.md with the appropriate frontmatter
2. Use the write tool to copy skill templates from ${dataDir}/skill-packs/loop-engine/ to ${dir}/skills/
3. If the loop has a schedule, use the update_loop_config tool to set the cron expression`;

        const session = sessionManager.create(config);
        await session.prompt(intent);
        sessionManager.dispose(session.sessionId ?? "");
        const round = body.clarifyRound ?? 0;

        // Check results (same logic as create)
        let clarifyContent: string | null = null;
        try {
          clarifyContent = await Bun.file(`${dir}/.clarify.json`).text();
        } catch {
          // file may not exist — ignore
        }

        if (clarifyContent) {
          // Clarification round gate: at round >= 2, stop asking and emit an
          // empty template so the user can finish it by hand.
          if (round >= 2) {
            try {
              await rm(`${dir}/.clarify.json`);
            } catch {
              // already gone — ignore
            }
            const preview = [
              "---",
              `projectId: `,
              "generator:",
              "  model: claude-sonnet-4",
              '  systemPrompt: ""',
              "evaluator:",
              "  model: claude-opus-4",
              '  systemPrompt: ""',
              'acceptance: ""',
              "---",
              "",
              `# ${job.name}`,
            ].join("\n");
            await Bun.write(`${dir}/LOOP.md`, preview);
            return {
              status: "generated",
              loop: {
                id,
                name: job.name,
                cronExpr: job.cronExpr,
                loopConfigPath: job.loopConfigPath,
                preview,
              },
              note: "已达澄清上限，已生成空模板，请手动编辑",
            };
          }
          const clarify = JSON.parse(clarifyContent) as { questions: string[] };
          return {
            status: "needs_clarification",
            loopId: id,
            questions: clarify.questions,
          };
        }

        let preview = "";
        try {
          preview = await Bun.file(`${dir}/LOOP.md`).text();
        } catch {
          // file may not exist — ignore
        }

        return {
          status: "generated",
          loop: {
            id,
            name: job.name,
            cronExpr: job.cronExpr,
            loopConfigPath: job.loopConfigPath,
            preview,
          },
        };
      },
      {
        body: t.Object({
          intent: t.String(),
          clarifyRound: t.Optional(t.Number()),
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
        loopConfigPath: resolveLoopPaths(job, dataDir).loopConfigPath,
        sessionManager,
        buildConfig,
        projectPort,
        dataDir,
        store,
        loopId: job.cronJobId,
        convPort,
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
          loopConfigPath: resolveLoopPaths(job, dataDir).loopConfigPath,
          sessionManager,
          buildConfig,
          projectPort,
          dataDir,
          action: {
            itemId: body.itemId,
            verdict: body.verdict,
            feedback: body.feedback,
          },
          store,
          loopId: job.cronJobId,
        });

        return { state, action: body.verdict };
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
