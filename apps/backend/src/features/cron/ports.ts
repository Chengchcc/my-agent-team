import type { CronJobRow } from "./domain.js";

export interface CreateCronJobRecord {
  cronJobId: string;
  name: string;
  agentId: string;
  cronExpr: string;
  prompt: string;
  enabled: boolean;
  timeoutMs: number;
  maxRetries: number;
  createdAt: number;
  updatedAt: number;
}

export interface UpdateCronJobRecord {
  name?: string;
  agentId?: string;
  cronExpr?: string;
  prompt?: string;
  enabled?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  updatedAt: number;
}

export interface CronJobPort {
  createCronJob(input: CreateCronJobRecord): CronJobRow;
  getCronJob(cronJobId: string): CronJobRow | null;
  listCronJobs(): CronJobRow[];
  listEnabledCronJobs(): CronJobRow[];
  updateCronJob(cronJobId: string, patch: UpdateCronJobRecord): CronJobRow | null;
  deleteCronJob(cronJobId: string): boolean;
}
