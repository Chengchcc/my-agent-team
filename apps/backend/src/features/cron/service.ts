import { OWNER_MEMBER_ID } from "../conversation/index.js";
import type { CronJobRow } from "./domain.js";
import type { CronJobPort } from "./ports.js";

export class CronJobNotFoundError extends Error {
  constructor(id: string) {
    super(`CronJob not found: ${id}`);
    this.name = "CronJobNotFoundError";
  }
}

export class CronJobValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronJobValidationError";
  }
}

/** Semantic validation of a 5-field cron expression.
 *  The HTTP/zod layer only checks field count; an expression like
 *  "99 99 99 99 99" passes that but makes Bun.cron throw at register time,
 *  which would 500 the request (after the row is already persisted) and,
 *  worse, abort scheduler.start()'s registration loop on reboot. We reject
 *  it up front by asking Bun to parse it. */
function assertValidCronExpr(expr: string): void {
  const parse = (Bun as unknown as { cron?: { parse?: (e: string) => unknown } }).cron?.parse;
  if (typeof parse !== "function") return; // older Bun: fall back to register-time guard
  try {
    parse(expr);
  } catch {
    throw new CronJobValidationError(`invalid cron expression: ${expr}`);
  }
}

export interface CronJobServiceDeps {
  port: CronJobPort;
  idGen: () => string;
  agentExists: (id: string) => Promise<boolean>;
  now?: () => number;
  convPort?: {
    createConversation: (input: {
      conversationId: string;
      title?: string;
      origin?: string;
    }) => void;
    addMember: (input: {
      conversationId: string;
      memberId: string;
      kind: "human" | "agent";
      agentId?: string;
    }) => void;
  };
}

export function createCronJobService(deps: CronJobServiceDeps) {
  const { port, idGen, agentExists } = deps;
  const now = deps.now ?? Date.now;

  function require(id: string): CronJobRow {
    const j = port.getCronJob(id);
    if (!j) throw new CronJobNotFoundError(id);
    return j;
  }

  return {
    port,

    async createCronJob(input: {
      name: string;
      agentId: string;
      cronExpr: string;
      prompt?: string;
      timeoutMs?: number;
      maxRetries?: number;
      enabled?: boolean;
    }): Promise<CronJobRow> {
      if (!(await agentExists(input.agentId))) {
        throw new CronJobValidationError(`agent not found: ${input.agentId}`);
      }
      assertValidCronExpr(input.cronExpr);
      const cronJobId = idGen();
      const ts = now();
      port.createCronJob({
        cronJobId,
        name: input.name,
        agentId: input.agentId,
        cronExpr: input.cronExpr,
        prompt: input.prompt ?? "",
        enabled: input.enabled ?? false,
        timeoutMs: input.timeoutMs ?? 0,
        maxRetries: input.maxRetries ?? 0,
        createdAt: ts,
        updatedAt: ts,
      });
      // best-effort self-owned conversation (conversationId = cronJobId)
      try {
        deps.convPort?.createConversation({
          conversationId: cronJobId,
          title: input.name,
          origin: "cron",
        });
        deps.convPort?.addMember({
          conversationId: cronJobId,
          memberId: OWNER_MEMBER_ID,
          kind: "agent",
          agentId: input.agentId,
        });
      } catch (e) {
        console.error(`[cron] conv bootstrap failed for ${cronJobId}: ${String(e)}`);
      }
      return require(cronJobId);
    },

    getById(id: string): CronJobRow {
      return require(id);
    },

    list(): CronJobRow[] {
      return port.listCronJobs();
    },

    exists(id: string): boolean {
      return port.getCronJob(id) !== null;
    },

    async update(
      id: string,
      patch: {
        name?: string;
        agentId?: string;
        cronExpr?: string;
        prompt?: string;
        timeoutMs?: number;
        maxRetries?: number;
        enabled?: boolean;
      },
    ): Promise<CronJobRow> {
      if (patch.agentId !== undefined && !(await agentExists(patch.agentId))) {
        throw new CronJobValidationError(`agent not found: ${patch.agentId}`);
      }
      if (patch.cronExpr !== undefined) assertValidCronExpr(patch.cronExpr);
      const result = port.updateCronJob(id, { ...patch, updatedAt: now() });
      if (!result) throw new CronJobNotFoundError(id);
      return result;
    },

    setEnabled(id: string, enabled: boolean): CronJobRow {
      const result = port.updateCronJob(id, { enabled, updatedAt: now() });
      if (!result) throw new CronJobNotFoundError(id);
      return result;
    },

    remove(id: string): void {
      if (!port.deleteCronJob(id)) throw new CronJobNotFoundError(id);
    },
  };
}

export type CronJobService = ReturnType<typeof createCronJobService>;
