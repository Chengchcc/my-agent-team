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
import { HttpError } from "../../infra/errors.js";
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
}

export function workflowRoutes(deps: {
  workflowExecutionService: WorkflowExecutionService;
  loadWorkflow: (ref: WorkflowRef) => Promise<string>;
  workflowDir: string;
  resyncTriggers?: () => Promise<void>;
  /** Emits a "changed" event on workflow writes (SSE live refresh). */
}) {
  const svc = deps.workflowExecutionService;
  const dir = deps.workflowDir;

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
        let meta: Record<string, unknown>;
        try {
          meta =
            (JSON.parse(readFileSync(join(dir, f), "utf-8")) as { meta?: Record<string, unknown> })
              .meta ?? {};
        } catch {
          meta = {};
        }
        const mtime = statSync(join(dir, f)).mtimeMs;
        let triggers: WorkflowDefinitionRow["triggers"];
        let valid: boolean;
        let error: string | undefined;
        try {
          const parsed = parseWorkflow(JSON.parse(readFileSync(join(dir, f), "utf-8")));
          valid = true;
          triggers = parsed.triggers as { type: "cron"; cron: string; enabled?: boolean }[];
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
    .delete("/api/workflow-definitions/:workflowId", async ({ params }) => {
      const file = workflowFile(params.workflowId);
      rmSync(file, { force: true });
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
        }),
      },
    )
    .get(
      "/api/workflow-executions",
      async ({ query }) => {
        const executions = await svc.listExecutions(query.workflowId ?? undefined);
        return { executions };
      },
      {
        query: t.Object({ workflowId: t.Optional(t.String()) }),
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
      return { execution: row, events, nodeRuns, pendingHuman };
    })
    .post("/api/workflow-executions/:executionId/cancel", async ({ params: { executionId } }) => {
      const row = await svc.cancelExecution(executionId);
      if (!row) throw new HttpError("Execution not found", 404);
      return row;
    })
    .delete("/api/workflow-executions/:executionId", async ({ params }) => {
      const ok = await svc.deleteExecution(params.executionId);
      return { ok };
    })
    .get("/api/workflow-executions/:executionId", async ({ params }) => {
      const row = await svc.getExecution(params.executionId);
      if (!row) throw new HttpError("Execution not found", 404);
      return row;
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
