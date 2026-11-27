import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseWorkflow } from "@chengchenccc/workflow";
import { Elysia, t } from "elysia";
import { safeTokenEqual } from "../../infra/auth.js";
import type { EntityLabelResolver } from "../../infra/entity-labels.js";
import { HttpError } from "../../infra/errors.js";
import { parseBoundedLimit, parseBoundedOffset } from "../../infra/http-utils.js";
import { createTokenBucketLimiter, type TokenBucketLimiter } from "../../infra/rate-limit.js";
import type { WorkflowExecutionRow } from "./domain.js";
import { dryRunWorkflow } from "./dry-run.js";
import type { WorkflowExecutionService } from "./service.js";

export interface WorkflowRef {
  /** Historically required and ignored — definitions load from the local
   *  workflows dir (`config.dataDir/workflows`). Still accepted so existing
   *  callers keep working; the git loader that would give it meaning is not
   *  implemented, and it would come back together with that loader. */
  repo?: string;
  path: string;
}

export interface WorkflowDefinitionRow {
  workflowId: string;
  name?: string;
  description?: string;
  tags?: string[];
  status?: string;
  owner?: string;
  updatedBy?: string;
  updatedAt: number;
  /** Parsed trigger declarations (cron); the list uses it for the
   *  scheduled-label badge. API/manual triggers are implicit and absent. */
  triggers?: { type: "cron"; cron: string; enabled?: boolean }[];
  /** False when the file does not parse: the definition is invisible to the
   *  scheduler and only lived in boot logs before this flag existed (four
   *  definition mistakes were found that way, one per backend restart). */
  valid?: boolean;
  /** The parse failure, verbatim, when valid is false. */
  error?: string;
  /** True when the definition has script nodes and this deployment has
   *  WORKFLOW_SCRIPTS_ENABLED unset: listed, but never runnable here. */
  scriptNodesBlocked?: boolean;
}

export function workflowRoutes(deps: {
  workflowExecutionService: WorkflowExecutionService;
  loadWorkflow: (ref: WorkflowRef) => Promise<string>;
  workflowDir: string;
  /** Script nodes may execute only when the deployment opted in; the env
   *  read belongs to the composition root, not the route. */
  scriptsEnabled?: boolean;
  resyncTriggers?: () => Promise<void>;
  /** Per-workflow webhook trigger token, stored OUTSIDE the agent-writable
   *  workflows dir (bootstrap wires this to the sealed settings KV). Absent
   *  deps = the token routes are off (tests without a store). */
  getTriggerToken?: (workflowId: string) => Promise<string | undefined>;
  setTriggerToken?: (workflowId: string, token: string) => Promise<void>;
  deleteTriggerToken?: (workflowId: string) => Promise<void>;
  /** ADR 0082 D5: optional batch label resolver for execution DTOs. */
  labelResolver?: EntityLabelResolver;
  /** Optional injectable rate limiter for the public webhook trigger endpoint. */
  triggerLimiter?: TokenBucketLimiter;
  /** Emits a "changed" event on workflow writes (SSE live refresh). */
}) {
  const svc = deps.workflowExecutionService;
  const dir = deps.workflowDir;
  const triggerLimiter =
    deps.triggerLimiter ?? createTokenBucketLimiter({ capacity: 30, refillPerSec: 1 });

  function enrichExecutions(rows: WorkflowExecutionRow[]): WorkflowExecutionRow[] {
    if (!deps.labelResolver || rows.length === 0) return rows;
    const maps = deps.labelResolver.resolveBatch({
      workflowIds: rows.map((r) => r.workflowId),
      requirementIds: rows.map((r) => r.requirementId),
      conversationIds: rows.map((r) => r.conversationId),
      projectIds: rows.map((r) => r.projectId),
    });
    return rows.map((r) => {
      const labels = deps.labelResolver!.labelsFor(
        {
          workflowId: r.workflowId,
          requirementId: r.requirementId,
          conversationId: r.conversationId,
          projectId: r.projectId,
        },
        maps,
      );
      return labels ? { ...r, labels } : r;
    });
  }

  function enrichExecution(row: WorkflowExecutionRow): WorkflowExecutionRow {
    return enrichExecutions([row])[0] ?? row;
  }

  // The id is a bare filename stem (same contract as mcp.ts safePath).
  // Elysia decodes %2F inside path params, so "../" survives routing —
  // validate the id, never join raw params.
  const WORKFLOW_ID_RE = /^[A-Za-z0-9._-]+$/;
  /** A definition that is not on disk is a client error that names it, not an
   *  ENOENT from the read surfacing as "Internal server error". The id check
   *  above is what keeps the path inside `dir`; callers pass the file they
   *  already resolved. */
  function requireDefinition(file: string, label: string): void {
    if (!existsSync(file)) {
      throw new HttpError(`workflow definition not found: ${label}`, 404);
    }
  }
  function workflowFile(workflowId: string): string {
    if (!WORKFLOW_ID_RE.test(workflowId)) {
      throw new HttpError(`invalid workflow id: ${workflowId}`, 400);
    }
    return join(dir, `${workflowId}.workflow.json`);
  }

  return new Elysia()
    .get("/api/workflow-definitions", async () => {
      mkdirSync(dir, { recursive: true });
      const files = readdirSync(dir).filter((f) => f.endsWith(".workflow.json"));
      const definitions: WorkflowDefinitionRow[] = files.map((f) => {
        const workflowId = f.replace(/\.workflow\.json$/, "");
        const filePath = join(dir, f);
        const mtime = statSync(filePath).mtimeMs;
        let rawJson: unknown;
        let parseErr: unknown = null;
        try {
          rawJson = JSON.parse(readFileSync(filePath, "utf-8"));
        } catch (err) {
          parseErr = err;
        }
        const meta =
          rawJson && typeof rawJson === "object" && "meta" in rawJson
            ? (((rawJson as { meta?: Record<string, unknown> }).meta ?? {}) as Record<
                string,
                unknown
              >)
            : {};
        let triggers: WorkflowDefinitionRow["triggers"];
        let scriptNodesBlocked = false;
        let valid: boolean;
        let error: string | undefined;
        try {
          if (parseErr) throw parseErr;
          const parsed = parseWorkflow(rawJson);
          valid = true;
          triggers = parsed.triggers as { type: "cron"; cron: string; enabled?: boolean }[];
          scriptNodesBlocked =
            parsed.nodes.some((n) => n.type === "script") && deps.scriptsEnabled !== true;
        } catch (err) {
          valid = false;
          error = err instanceof Error ? err.message : String(err);
          triggers = undefined;
        }
        return {
          valid,
          ...(error ? { error } : {}),
          workflowId,
          name: typeof meta.name === "string" ? meta.name : undefined,
          description: typeof meta.description === "string" ? meta.description : undefined,
          tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : undefined,
          status: typeof meta.status === "string" ? meta.status : undefined,
          owner: typeof meta.owner === "string" ? meta.owner : undefined,
          updatedBy: typeof meta.updatedBy === "string" ? meta.updatedBy : undefined,
          updatedAt: Math.round(mtime),
          triggers,
          scriptNodesBlocked,
        };
      });
      return { definitions };
    })
    .get("/api/workflow-definitions/:workflowId", async ({ params }) => {
      const file = workflowFile(params.workflowId);
      requireDefinition(file, params.workflowId);
      const raw = await Bun.file(file).text();
      return { definition: JSON.parse(raw) };
    })
    .put(
      "/api/workflow-definitions/:workflowId",
      async ({ params, body }) => {
        mkdirSync(dir, { recursive: true });
        const file = workflowFile(params.workflowId);
        // Validate BEFORE persisting: parseWorkflow is the trust boundary the
        // trigger scheduler (and every execution) relies on. An unvalidated
        // definition used to brick trigger sync / backend boot.
        try {
          parseWorkflow(body.definition);
        } catch (err) {
          throw new HttpError(
            `invalid workflow definition: ${err instanceof Error ? err.message : String(err)}`,
            400,
          );
        }
        writeFileSync(file, JSON.stringify(body.definition, null, 2));
        void deps.resyncTriggers?.();
        return { ok: true, definition: body.definition };
      },
      {
        body: t.Object({
          definition: t.Record(t.String(), t.Unknown()),
        }),
      },
    )

    .post(
      "/api/workflow-definitions/:workflowId/dry-run",
      async ({ params, body }) => {
        const file = workflowFile(params.workflowId);
        requireDefinition(file, params.workflowId);
        const raw = await Bun.file(file).text();
        const definition = JSON.parse(raw);
        return dryRunWorkflow(
          definition,
          body.input ?? {},
          body.mockOutputs ?? {},
          body.startNodeId,
        );
      },
      {
        body: t.Object({
          input: t.Optional(t.Record(t.String(), t.Unknown())),
          mockOutputs: t.Optional(t.Record(t.String(), t.Record(t.String(), t.Unknown()))),
          startNodeId: t.Optional(t.String()),
        }),
      },
    )
    .post("/api/workflow-definitions/:workflowId/trigger-token", async ({ params }) => {
      // Rotate: each call replaces the token, so a leak is one call away from
      // being fixed. Returns the new token exactly once, here.
      workflowFile(params.workflowId);
      if (!deps.setTriggerToken || !deps.getTriggerToken) {
        throw new HttpError("trigger tokens are not configured on this backend", 501);
      }
      const token = randomBytes(24).toString("hex");
      await deps.setTriggerToken(params.workflowId, token);
      return { token };
    })
    .post(
      "/api/workflow-triggers/:workflowId",
      async ({ params, body, headers, set }) => {
        // Public entry (exempted from the app token in app.ts): the caller only
        // holds this workflow's trigger token, not the backend token. GitHub,
        // n8n, curl - anything that can set one header.
        workflowFile(params.workflowId);
        const rate = triggerLimiter.consume(params.workflowId);
        if (!rate.allowed) {
          set.status = 429;
          set.headers["retry-after"] = String(rate.retryAfterSec);
          return { error: "Too many webhook trigger requests" };
        }
        if (!deps.getTriggerToken) {
          throw new HttpError("trigger tokens are not configured on this backend", 501);
        }
        const stored = await deps.getTriggerToken(params.workflowId);
        const given =
          typeof headers["x-trigger-token"] === "string" ? headers["x-trigger-token"] : "";
        // Constant-time digest compare: safe for arbitrary UTF-8 headers and
        // leaks neither token length nor whether this workflow has a token.
        const ok = stored !== undefined && stored.length > 0 && safeTokenEqual(given, stored);
        if (!ok) {
          set.status = 401;
          return { error: "Unauthorized" };
        }
        let raw: string;
        try {
          raw = await deps.loadWorkflow({ path: `${params.workflowId}.workflow.json` });
        } catch {
          set.status = 404;
          return { error: `workflow definition not found: ${params.workflowId}` };
        }
        set.status = 201;
        return await svc.startExecution({
          workflowId: params.workflowId,
          definition: JSON.parse(raw),
          input: body,
          triggeredBy: "webhook",
        });
      },
      { body: t.Record(t.String(), t.Unknown()) },
    )
    .delete("/api/workflow-definitions/:workflowId", async ({ params }) => {
      const file = workflowFile(params.workflowId);
      rmSync(file, { force: true });
      await deps.deleteTriggerToken?.(params.workflowId);
      void deps.resyncTriggers?.();
      return { ok: true };
    })
    .post(
      "/api/workflow-executions",
      async ({ body, set }) => {
        // Bare "<stem>.workflow.json" only — loadWorkflow joins dataDir/workflows
        // with this path, so an unchecked "../../" reads arbitrary JSON files
        // (and echoes their parsed content back in the execution row).
        const stem = /^(.+)\.workflow\.json$/.exec(body.workflowRef.path)?.[1];
        if (!stem || !WORKFLOW_ID_RE.test(stem)) {
          throw new HttpError(`invalid workflowRef.path: ${body.workflowRef.path}`, 400);
        }
        const ref: WorkflowRef = { repo: body.workflowRef.repo, path: body.workflowRef.path };
        // The loader reads from disk; check the file here so a typo in the
        // path is a 404 naming it instead of an ENOENT turned into a 500.
        requireDefinition(workflowFile(stem), ref.path);
        const raw = await deps.loadWorkflow(ref);
        const definition = JSON.parse(raw);
        set.status = 201;
        const workflowId = stem;
        const input: Record<string, unknown> = { ...(body.input ?? {}) };
        if (body.artifacts?.length) input.__artifacts = body.artifacts;
        return await svc.startExecution({
          workflowId,
          definition,
          input,
          requirementId: body.requirementId ?? null,
          conversationId: body.conversationId ?? null,
          projectId: body.projectId ?? null,
        });
      },
      {
        body: t.Object({
          workflowRef: t.Object({
            repo: t.Optional(t.String()),
            path: t.String({ minLength: 1 }),
          }),
          input: t.Optional(t.Record(t.String(), t.Unknown())),
          artifacts: t.Optional(t.Array(t.String())),
          requirementId: t.Optional(t.String({ minLength: 1 })),
          conversationId: t.Optional(t.String({ minLength: 1 })),
          projectId: t.Optional(t.String({ minLength: 1 })),
        }),
      },
    )
    .get(
      "/api/workflow-executions",
      async ({ query }) => {
        const filter = {
          ...(query.workflowId ? { workflowId: query.workflowId } : {}),
          ...(query.requirementId ? { requirementId: query.requirementId } : {}),
          ...(query.conversationId ? { conversationId: query.conversationId } : {}),
          ...(query.projectId ? { projectId: query.projectId } : {}),
        };
        const executions = await svc.listExecutions(
          Object.keys(filter).length > 0 ? filter : undefined,
        );
        const limit = parseBoundedLimit(query.limit, 100, 500);
        const offset = parseBoundedOffset(query.offset);
        const page =
          query.limit !== undefined || query.offset !== undefined
            ? executions.slice(offset, offset + limit)
            : executions.slice(0, 500);
        return { executions: enrichExecutions(page) };
      },
      {
        query: t.Object({
          workflowId: t.Optional(t.String()),
          requirementId: t.Optional(t.String()),
          conversationId: t.Optional(t.String()),
          projectId: t.Optional(t.String()),
          limit: t.Optional(t.String()),
          offset: t.Optional(t.String()),
        }),
      },
    )
    .get("/api/workflow-executions/:executionId/trace", async ({ params }) => {
      const row = await svc.getExecution(params.executionId);
      if (!row) throw new HttpError("Execution not found", 404);
      const events = await svc.listExecutionEvents(params.executionId);
      const nodeRuns = await svc.listNodeRuns(params.executionId);
      let pendingHuman = null;
      if (row.status === "waiting_human") {
        const waiting = nodeRuns.find((r) => r.status === "waiting_human");
        if (waiting) pendingHuman = await svc.getPendingHuman(params.executionId, waiting.nodeId);
      }
      return { execution: enrichExecution(row), events, nodeRuns, pendingHuman };
    })
    .post("/api/workflow-executions/:executionId/cancel", async ({ params: { executionId } }) => {
      const row = await svc.cancelExecution(executionId);
      if (!row) throw new HttpError("Execution not found", 404);
      return enrichExecution(row);
    })
    .delete("/api/workflow-executions/:executionId", async ({ params }) => {
      const ok = await svc.deleteExecution(params.executionId);
      return { ok };
    })
    .get("/api/workflow-executions/:executionId", async ({ params }) => {
      const row = await svc.getExecution(params.executionId);
      if (!row) throw new HttpError("Execution not found", 404);
      return enrichExecution(row);
    })

    .post(
      "/api/workflow-executions/human-tasks/batch-resolve",
      async ({ body }) => {
        return { results: await svc.resolveHumanTasks(body.decisions) };
      },
      {
        body: t.Object({
          decisions: t.Array(
            t.Object({
              executionId: t.String({ minLength: 1 }),
              nodeId: t.String({ minLength: 1 }),
              answer: t.Optional(t.Record(t.String(), t.Unknown())),
            }),
          ),
        }),
      },
    )

    .post(
      "/api/workflow-executions/:executionId/human-task",
      async ({ params, body }) => {
        return await svc.resolveHumanTask(params.executionId, body.nodeId, body.answer ?? {});
      },
      {
        body: t.Object({
          nodeId: t.String({ minLength: 1 }),
          answer: t.Optional(t.Record(t.String(), t.Unknown())),
        }),
      },
    );
}

export type WorkflowRoutes = ReturnType<typeof workflowRoutes>;
