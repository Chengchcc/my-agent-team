import { z } from "zod";
import { json, sseResponse } from "../../http/response.js";
import type { DeliverableService } from "../deliverable/service.js";
import { ISSUE_STATUSES, ORDER } from "../orchestrator/transitions.js";
import type { RuntimeOpsStore } from "../runtime-ops/store.js";
import type { IssueRow, IssueStatus } from "./entities.js";
import {
  IllegalTransitionError,
  IssueNotFoundError,
  type IssueService,
  ValidationError,
} from "./service.js";

const createSchema = z.object({
  projectId: z.string().trim().min(1),
  title: z.string().trim().min(1),
});

const transitionSchema = z.object({ to: z.enum(ISSUE_STATUSES as readonly [string, ...string[]]) });

const deliverableSchema = z.object({
  kind: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-z][a-z0-9_]*$/, "kind must be lowercase alphanumeric"),
  fields: z.record(z.string()),
  ref: z.string().optional(),
  runId: z.string().optional(),
});

export function issueRoutes(
  svc: IssueService,
  opsStore: RuntimeOpsStore,
  deliverableSvc: DeliverableService,
  opts?: { onIssueStarted?: (issue: IssueRow) => Promise<unknown> },
) {
  const { onIssueStarted } = opts ?? {};

  return {
    /** POST /api/issues → 201 { issue } */
    async create(req: Request): Promise<Response> {
      const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);
      try {
        const issue = svc.createIssue(parsed.data);
        return json({ issue }, 201);
      } catch (err) {
        if (err instanceof ValidationError) return json({ error: err.message }, 400);
        throw err;
      }
    },

    /** GET /api/issues?projectId= → 200 { issues } */
    list(req: Request): Response {
      const projectId = new URL(req.url).searchParams.get("projectId") ?? undefined;
      return json({ issues: svc.port.listIssues(projectId ? { projectId } : undefined) });
    },

    /** GET /api/issues/:id → 200 { issue } | 404 */
    get(_req: Request, issueId: string): Response {
      const issue = svc.port.getIssue(issueId);
      if (!issue) return json({ error: "Not found" }, 404);
      return json({ issue });
    },

    /** POST /api/issues/:id/transition { to } → 200 { issue } | 404 | 409 */
    async transition(req: Request, issueId: string): Promise<Response> {
      const parsed = transitionSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);
      try {
        const fromStatus = svc.port.getIssue(issueId)?.status;
        const toStatus = parsed.data.to as IssueStatus;
        const updated = svc.applyTransition(issueId, toStatus);
        // M18.4: forward transitions (excluding terminal done) trigger orchestrator.
        // This covers draft→planned (the original start signal) AND manual forward
        // drags like planned→in_progress (human takes over that step).
        if (
          fromStatus &&
          ORDER.indexOf(toStatus) > ORDER.indexOf(fromStatus) &&
          toStatus !== "done"
        ) {
          void onIssueStarted?.(updated).catch((e) =>
            console.error(`[orchestrator] startStep failed for ${issueId}: ${String(e)}`),
          );
        }
        return json({ issue: updated });
      } catch (err) {
        if (err instanceof IssueNotFoundError) return json({ error: err.message }, 404);
        if (err instanceof IllegalTransitionError) return json({ error: err.message }, 409);
        throw err;
      }
    },

    /** POST /api/issues/:id/deliverables → 201 | 200(replay) | 400 | 404 | 409
     *  R3: fromStatus is read from run_origin.from_status (authoritative), never parsed from a string.
     *  R1: idempotency is (runId, kind) — INSERT … ON CONFLICT in adapter. */
    async submitDeliverable(req: Request, issueId: string): Promise<Response> {
      const parsed = deliverableSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);
      if (!svc.port.getIssue(issueId)) return json({ error: "issue not found" }, 404);

      // R3: runId provided → origin must exist and issueId must match (hard 409, no fallback)
      let fromStatus = "";
      if (parsed.data.runId) {
        const origin = opsStore.getRunOrigin(parsed.data.runId);
        if (!origin) return json({ error: "run not found" }, 409);
        if (origin.issueId && origin.issueId !== issueId)
          return json({ error: "run/issue mismatch" }, 409);
        fromStatus = origin.fromStatus;
      }

      // R2: atomic upsert — adapter handles ON CONFLICT, returns { row, replay }
      const { row, replay } = deliverableSvc.submit({
        issueId,
        fromStatus,
        kind: parsed.data.kind,
        fields: parsed.data.fields,
        ref: parsed.data.ref,
        runId: parsed.data.runId,
      });

      return json({ deliverable: row }, replay ? 200 : 201);
    },

    /** GET /api/issue-meta → 200 { statuses } */
    meta(): Response {
      return json({ statuses: ISSUE_STATUSES });
    },

    /** GET /api/issues/events → SSE */
    async events(req: Request): Promise<Response> {
      const stream = svc.subscribeIssues({ signal: req.signal });
      return sseResponse(
        stream,
        (row) => ({
          id: (row as IssueRow).issueId,
          event: "issue",
          data: row,
        }),
        req.signal,
      );
    },
  };
}
