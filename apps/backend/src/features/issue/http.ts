import type { IssueEvent } from "@my-agent-team/api-contract";
import {
  createSseEncoder,
  issueBoardEvents,
  issueTimelineEvents,
} from "@my-agent-team/api-contract";
import { Elysia, t } from "elysia";
import { sseResponse } from "../../http/response.js";
import type { DeliverableService } from "../deliverable/service.js";
import { BACKWARD_EDGES, ISSUE_STATUSES, ORDER } from "../orchestrator/transitions.js";
import { emitIssueEvent } from "../runtime-ops/emit-issue-event.js";
import type { RuntimeOpsStore } from "../runtime-ops/store.js";
import { subscribeIssueTimeline } from "../runtime-ops/subscribe-issue-timeline.js";
import type { IssueRow, IssueStatus } from "./entities.js";
import {
  IllegalTransitionError,
  IssueNotFoundError,
  type IssueService,
  ValidationError,
} from "./service.js";

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

  return (
    new Elysia()
      .get("/api/issue-meta", () => ({ statuses: ISSUE_STATUSES }))
      .post(
        "/api/issues",
        async ({ body, set }) => {
          try {
            const issue = svc.createIssue(body);
            emitIssueEvent(opsStore, issue.issueId, "created", {
              projectId: issue.projectId,
              title: issue.title,
            });
            set.status = 201;
            return { issue };
          } catch (err) {
            if (err instanceof ValidationError)
              return Response.json({ error: err.message }, { status: 400 });
            throw err;
          }
        },
        {
          body: t.Object({
            projectId: t.String({ minLength: 1 }),
            title: t.String({ minLength: 1 }),
            description: t.Optional(t.String()),
            priority: t.Optional(
              t.Union([t.Literal("P0"), t.Literal("P1"), t.Literal("P2"), t.Literal("P3")]),
            ),
            estimatedCompletionAt: t.Optional(t.Union([t.Number(), t.Null()])),
          }),
        },
      )
      .get("/api/issues", ({ query: { projectId } }) => ({
        issues: svc.port.listIssues(projectId ? { projectId } : undefined),
      }))
      .get("/api/issues/:id", ({ params: { id: issueId } }) => {
        const issue = svc.port.getIssue(issueId);
        if (!issue) return Response.json({ error: "Not found" }, { status: 404 });
        return { issue };
      })
      .patch(
        "/api/issues/:id",
        ({ params: { id: issueId }, body }) => {
          try {
            const issue = svc.updateIssue(issueId, body);
            return { issue };
          } catch (err) {
            if (err instanceof IssueNotFoundError)
              return Response.json({ error: err.message }, { status: 404 });
            if (err instanceof ValidationError)
              return Response.json({ error: err.message }, { status: 400 });
            throw err;
          }
        },
        {
          body: t.Object({
            title: t.Optional(t.String({ minLength: 1 })),
            description: t.Optional(t.String()),
            priority: t.Optional(
              t.Union([t.Literal("P0"), t.Literal("P1"), t.Literal("P2"), t.Literal("P3")]),
            ),
            estimatedCompletionAt: t.Optional(t.Union([t.Number(), t.Null()])),
          }),
        },
      )
      .delete("/api/issues/:id", ({ params: { id: issueId }, set }) => {
        try {
          svc.deleteIssue(issueId);
          set.status = 204;
          return "";
        } catch (err) {
          if (err instanceof IssueNotFoundError)
            return Response.json({ error: err.message }, { status: 404 });
          throw err;
        }
      })
      .post(
        "/api/issues/:id/transition",
        ({ params: { id: issueId }, body }) => {
          try {
            const fromStatus = svc.port.getIssue(issueId)?.status;
            const toStatus = body.to as IssueStatus;
            if (
              fromStatus &&
              BACKWARD_EDGES.some((e) => e.from === fromStatus && e.to === toStatus)
            ) {
              return Response.json(
                { error: `backward transition ${fromStatus}→${toStatus} requires review-decision` },
                { status: 409 },
              );
            }
            const updated = svc.applyTransition(issueId, toStatus);
            emitIssueEvent(opsStore, issueId, "status.advanced", {
              from: fromStatus,
              to: toStatus,
              by: "human",
            });
            if (fromStatus === "draft" && toStatus === "planned") {
              emitIssueEvent(opsStore, issueId, "started", { from: "draft", to: "planned" });
            }
            if (
              fromStatus &&
              ORDER.indexOf(toStatus) > ORDER.indexOf(fromStatus) &&
              toStatus !== "done"
            ) {
              void onIssueStarted?.(updated).catch((e) =>
                console.error(`[orchestrator] startStep failed for ${issueId}: ${String(e)}`),
              );
            }
            return { issue: updated };
          } catch (err) {
            if (err instanceof IssueNotFoundError)
              return Response.json({ error: err.message }, { status: 404 });
            if (err instanceof IllegalTransitionError)
              return Response.json({ error: err.message }, { status: 409 });
            throw err;
          }
        },
        { body: t.Object({ to: t.String() }) },
      )
      .post(
        "/api/issues/:id/deliverables",
        ({ params: { id: issueId }, body, set }) => {
          if (!svc.port.getIssue(issueId))
            return Response.json({ error: "issue not found" }, { status: 404 });
          let fromStatus = "";
          if (body.spanId) {
            const origin = opsStore.getSpanOrigin(body.spanId);
            if (!origin) return Response.json({ error: "run not found" }, { status: 409 });
            if (origin.issueId && origin.issueId !== issueId)
              return Response.json({ error: "run/issue mismatch" }, { status: 409 });
            fromStatus = origin.fromStatus;
          }
          const { row, replay } = deliverableSvc.submit({
            issueId,
            fromStatus,
            kind: body.kind,
            fields: body.fields,
            ref: body.ref,
            spanId: body.spanId,
          });
          if (!replay) {
            emitIssueEvent(opsStore, issueId, "deliverable.submitted", {
              kind: row.kind,
              deliverableId: row.deliverableId,
              spanId: row.spanId ?? null,
              ref: row.ref ?? null,
            });
          }
          set.status = replay ? 200 : 201;
          return { deliverable: row };
        },
        {
          body: t.Object({
            kind: t.String({ minLength: 1 }),
            fields: t.Record(t.String(), t.String()),
            ref: t.Optional(t.String()),
            spanId: t.Optional(t.String()),
          }),
        },
      )
      .post(
        "/api/issues/:id/review-decision",
        async ({ params: { id: issueId }, body }) => {
          const issue = svc.port.getIssue(issueId);
          if (!issue) return Response.json({ error: "Not found" }, { status: 404 });
          if (issue.status !== "in_review")
            return Response.json(
              { error: `issue not awaiting review (status=${issue.status})` },
              { status: 409 },
            );
          try {
            if (body.decision === "approve") {
              const updated = svc.applyTransition(issueId, "done");
              emitIssueEvent(opsStore, issueId, "human.decided", { decision: "approve" });
              emitIssueEvent(opsStore, issueId, "status.advanced", {
                from: "in_review",
                to: "done",
                by: "human",
              });
              return { issue: updated };
            }
            const updated = svc.applyTransition(issueId, "in_progress");
            emitIssueEvent(opsStore, issueId, "human.decided", {
              decision: "reject",
              note: body.note,
            });
            emitIssueEvent(opsStore, issueId, "status.advanced", {
              from: "in_review",
              to: "in_progress",
              by: "rework",
            });
            try {
              const d = deliverableSvc.submit({
                issueId,
                fromStatus: "in_review",
                kind: "rework_feedback",
                fields: { note: body.note },
              });
              emitIssueEvent(opsStore, issueId, "deliverable.submitted", {
                kind: "rework_feedback",
                deliverableId: d.row.deliverableId,
                spanId: null,
                ref: null,
              });
              await onReviewRejected?.(updated);
            } catch (e) {
              console.error(`[orchestrator] rework reject failed for ${issueId}: ${String(e)}`);
              try {
                const reverted = svc.revertReviewReject(issueId);
                emitIssueEvent(opsStore, issueId, "status.advanced", {
                  from: "in_progress",
                  to: "in_review",
                  by: "revert",
                });
                return Response.json(
                  { error: "rework failed; issue returned to in_review", issue: reverted },
                  { status: 502 },
                );
              } catch (rollbackErr) {
                console.error(
                  `[orchestrator] rollback failed for ${issueId}: ${String(rollbackErr)}`,
                );
                return Response.json(
                  { error: "rework failed and rollback failed", issue: updated },
                  { status: 500 },
                );
              }
            }
            return { issue: updated };
          } catch (err) {
            if (err instanceof IssueNotFoundError)
              return Response.json({ error: err.message }, { status: 404 });
            if (err instanceof IllegalTransitionError)
              return Response.json({ error: err.message }, { status: 409 });
            throw err;
          }
        },
        {
          body: t.Union([
            t.Object({ decision: t.Literal("approve") }),
            t.Object({ decision: t.Literal("reject"), note: t.String({ minLength: 1 }) }),
          ]),
        },
      )
      .get("/api/issues/:id/timeline", ({ params: { id: issueId } }) => {
        if (!svc.port.getIssue(issueId))
          return Response.json({ error: "Not found" }, { status: 404 });
        return { events: opsStore.getIssueEvents(issueId) };
      })
      .get("/api/issues/:id/detail", ({ params: { id: issueId } }) => {
        const issue = svc.port.getIssue(issueId);
        if (!issue) return Response.json({ error: "Not found" }, { status: 404 });
        const timeline = opsStore.getIssueEvents(issueId);
        const origins = opsStore.getSpanOriginsByIssueId(issueId);
        const runIds = origins.map((o) => o.spanId);
        const runMap = new Map(opsStore.getRuns(runIds).map((r) => [r.spanId, r]));
        const runs = origins.map((o) => {
          const run = runMap.get(o.spanId);
          return {
            spanId: o.spanId,
            fromStatus: o.fromStatus,
            agentId: o.agentMemberId,
            createdAt: o.createdAt,
            status: run?.status ?? "unknown",
            endedAt: run?.endedAt ?? null,
          };
        });
        return { issue, timeline, runs };
      })
      // SSE — returns raw Response (stream)
      .get("/api/issues/events", ({ request }) => {
        const stream = svc.subscribeIssues({ signal: request.signal });
        const encodeIssue = createSseEncoder(issueBoardEvents);
        return sseResponse(
          stream,
          (item) => {
            if ("_heartbeat" in item)
              throw new Error("unreachable: heartbeat filtered by sseResponse");
            const row: IssueRow = item;
            return encodeIssue("issue", row, row.issueId);
          },
          request.signal,
        );
      })
      .get("/api/issues/:id/timeline/events", ({ request, params: { id: issueId } }) => {
        if (!svc.port.getIssue(issueId))
          return Response.json({ error: "Not found" }, { status: 404 });
        const stream = subscribeIssueTimeline(opsStore, issueId, { signal: request.signal });
        const encodeTimeline = createSseEncoder(issueTimelineEvents);
        return sseResponse(
          stream,
          (item) => {
            if ("_heartbeat" in item)
              throw new Error("unreachable: heartbeat filtered by sseResponse");
            const event: IssueEvent = item;
            return encodeTimeline("issue-event", event, String(event.seq));
          },
          request.signal,
        );
      })
  );
}
