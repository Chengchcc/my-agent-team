import { z } from "zod";
import { json, sseResponse } from "../../http/response.js";
import type { DeliverableService } from "../deliverable/service.js";
import { BACKWARD_EDGES, ISSUE_STATUSES, ORDER } from "../orchestrator/transitions.js";
import { emitIssueEvent } from "../runtime-ops/emit-issue-event.js";
import type { RuntimeOpsStore } from "../runtime-ops/store.js";
import { subscribeIssueTimeline } from "../runtime-ops/subscribe-issue-timeline.js";
import type { IssueEvent } from "../runtime-ops/types.js";
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

const reviewDecisionSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    note: z.string().trim().optional(),
  })
  .refine((d) => d.decision === "approve" || (d.note && d.note.length > 0), {
    message: "note is required when rejecting",
    path: ["note"],
  });

export function issueRoutes(
  svc: IssueService,
  opsStore: RuntimeOpsStore,
  deliverableSvc: DeliverableService,
  opts?: {
    onIssueStarted?: (issue: IssueRow) => Promise<unknown>;
    onReviewRejected?: (issue: IssueRow) => Promise<unknown>;
  },
) {
  const { onIssueStarted, onReviewRejected } = opts ?? {};

  return {
    /** POST /api/issues → 201 { issue } */
    async create(req: Request): Promise<Response> {
      const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);
      try {
        const issue = svc.createIssue(parsed.data);
        emitIssueEvent(opsStore, issue.issueId, "created", {
          projectId: issue.projectId,
          title: issue.title,
        });
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
        // Reject backward edges — rework must go through review-decision (single entry point)
        if (fromStatus && BACKWARD_EDGES.some((e) => e.from === fromStatus && e.to === toStatus)) {
          return json(
            { error: `backward transition ${fromStatus}→${toStatus} requires review-decision` },
            409,
          );
        }
        const updated = svc.applyTransition(issueId, toStatus);
        emitIssueEvent(opsStore, issueId, "status.advanced", {
          from: fromStatus,
          to: toStatus,
          by: "human",
        });
        // draft→planned is the explicit start signal
        if (fromStatus === "draft" && toStatus === "planned") {
          emitIssueEvent(opsStore, issueId, "started", {
            from: "draft",
            to: "planned",
          });
        }
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

      if (!replay) {
        emitIssueEvent(opsStore, issueId, "deliverable.submitted", {
          kind: row.kind,
          deliverableId: row.deliverableId,
          runId: row.runId ?? null,
          ref: row.ref ?? null,
        });
      }

      return json({ deliverable: row }, replay ? 200 : 201);
    },

    /** POST /api/issues/:id/review-decision → 200 { issue } | 400 | 404 | 409
     *  approve → in_review→done (terminal, no run started).
     *  reject  → write rework_feedback deliverable → in_review→in_progress → startStep (rework). */
    async reviewDecision(req: Request, issueId: string): Promise<Response> {
      const parsed = reviewDecisionSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);

      const issue = svc.port.getIssue(issueId);
      if (!issue) return json({ error: "Not found" }, 404);
      if (issue.status !== "in_review")
        return json({ error: `issue not awaiting review (status=${issue.status})` }, 409);

      try {
        if (parsed.data.decision === "approve") {
          const updated = svc.applyTransition(issueId, "done");
          emitIssueEvent(opsStore, issueId, "human.decided", {
            decision: "approve",
          });
          emitIssueEvent(opsStore, issueId, "status.advanced", {
            from: "in_review",
            to: "done",
            by: "human",
          });
          return json({ issue: updated });
        }
        // reject: applyTransition first (CAS serializes concurrent rejects),
        // then write feedback, then await rework run start.
        const updated = svc.applyTransition(issueId, "in_progress");
        emitIssueEvent(opsStore, issueId, "human.decided", {
          decision: "reject",
          note: parsed.data.note,
        });
        emitIssueEvent(opsStore, issueId, "status.advanced", {
          from: "in_review",
          to: "in_progress",
          by: "rework",
        });
        const d = deliverableSvc.submit({
          issueId,
          fromStatus: "in_review",
          kind: "rework_feedback",
          fields: { note: parsed.data.note! },
        });
        emitIssueEvent(opsStore, issueId, "deliverable.submitted", {
          kind: "rework_feedback",
          deliverableId: d.row.deliverableId,
          runId: null,
          ref: null,
        });
        try {
          await onReviewRejected?.(updated);
        } catch (e) {
          // Rework run failed to start — compensation rollback to in_review
          console.error(`[orchestrator] rework start failed for ${issueId}: ${String(e)}`);
          try {
            const reverted = svc.revertReviewReject(issueId);
            return json(
              {
                error: "rework run failed to start; issue returned to in_review",
                issue: reverted,
              },
              502,
            );
          } catch (rollbackErr) {
            console.error(
              `[orchestrator] rollback in_progress→in_review failed for ${issueId}: ${String(rollbackErr)}`,
            );
            return json({ error: "rework run failed and rollback failed", issue: updated }, 500);
          }
        }
        return json({ issue: updated });
      } catch (err) {
        if (err instanceof IssueNotFoundError) return json({ error: err.message }, 404);
        if (err instanceof IllegalTransitionError) return json({ error: err.message }, 409);
        throw err;
      }
    },

    /** GET /api/issues/:id/timeline → 200 { events } */
    timeline(_req: Request, issueId: string): Response {
      if (!svc.port.getIssue(issueId)) return json({ error: "Not found" }, 404);
      return json({ events: opsStore.getIssueEvents(issueId) });
    },

    /** GET /api/issues/:id/timeline/events → SSE */
    async timelineEvents(req: Request, issueId: string): Promise<Response> {
      if (!svc.port.getIssue(issueId)) return json({ error: "Not found" }, 404);
      const stream = subscribeIssueTimeline(opsStore, issueId, { signal: req.signal });
      return sseResponse(
        stream,
        (e) => ({
          id: String((e as IssueEvent).seq ?? ""),
          event: "issue-event",
          data: e,
        }),
        req.signal,
      );
    },

    /** GET /api/issues/:id/detail → 200 { issue, timeline, runs } */
    detail(_req: Request, issueId: string): Response {
      const issue = svc.port.getIssue(issueId);
      if (!issue) return json({ error: "Not found" }, 404);
      const timeline = opsStore.getIssueEvents(issueId);
      const origins = opsStore.getRunOriginsByIssueId(issueId);
      const runIds = origins.map((o) => o.runId);
      const runMap = new Map(opsStore.getRuns(runIds).map((r) => [r.runId, r]));
      const runs = origins.map((o) => {
        const run = runMap.get(o.runId);
        return {
          runId: o.runId,
          fromStatus: o.fromStatus,
          agentId: o.agentMemberId,
          createdAt: o.createdAt,
          status: run?.status ?? "unknown",
          endedAt: run?.endedAt ?? null,
        };
      });
      return json({ issue, timeline, runs });
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
