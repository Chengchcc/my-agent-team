import type { CronJobPort } from "../cron/ports.js";
import type { CronScheduler } from "../cron/scheduler.js";

export function createUpdateLoopConfigTool(
  cronJobId: string,
  port: CronJobPort,
  scheduler: CronScheduler,
) {
  return {
    name: "update_loop_config",
    description: "Set the cron schedule for this Loop",
    inputSchema: {
      type: "object" as const,
      properties: {
        cronExpr: {
          type: "string" as const,
          description: "5-field cron expression (e.g. '0 8 * * *')",
        },
      },
      required: ["cronExpr"],
    },
    execute: async (input: { cronExpr: string }) => {
      const parts = input.cronExpr.trim().split(/\s+/);
      if (parts.length !== 5) {
        throw new Error("Must be a 5-field cron expression");
      }

      port.updateCronJob(cronJobId, {
        cronExpr: input.cronExpr,
        updatedAt: Date.now(),
      });

      const job = port.getCronJob(cronJobId);
      if (job) scheduler.register(job);
    },
  };
}
