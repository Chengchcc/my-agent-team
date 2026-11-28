import { Elysia, t } from "elysia";
import { parseBoundedLimit } from "../../infra/http-utils.js";
import type { EvalService } from "./service.js";

/** ADR 0085 D4/D5/D7: Eval suites (Git-backed files), eval runs & A/B diffs,
 *  and production run feedback / promote-to-eval endpoints. */
export function evalRoutes(svc: EvalService) {
  return (
    new Elysia()
      .get("/api/eval-suites", () => ({ suites: svc.listSuites() }))
      .get("/api/eval-suites/:suiteId", ({ params: { suiteId } }) => svc.getSuite(suiteId))
      .put(
        "/api/eval-suites/:suiteId",
        ({ params: { suiteId }, body }) => {
          const { summary, ...suiteBody } = body as Record<string, unknown> & { summary?: string };
          return svc.saveSuite(suiteId, suiteBody, {
            author: "user",
            ...(typeof summary === "string" && summary.trim() ? { summary: summary.trim() } : {}),
          });
        },
        { body: t.Record(t.String(), t.Any()) },
      )
      .delete("/api/eval-suites/:suiteId", ({ params: { suiteId } }) => svc.deleteSuite(suiteId))
      .get(
        "/api/eval-suites/:suiteId/history",
        ({ params: { suiteId }, query }) =>
          svc.suiteHistory(suiteId, parseBoundedLimit(query.limit, 20, 100)),
        { query: t.Object({ limit: t.Optional(t.String()) }) },
      )
      .post(
        "/api/eval-suites/:suiteId/revert",
        ({ params: { suiteId }, body }) => svc.revertSuite(suiteId, body.commit),
        { body: t.Object({ commit: t.String({ minLength: 7 }) }) },
      )
      .post(
        "/api/eval-suites/:suiteId/runs",
        ({ params: { suiteId }, body }) =>
          svc.startEvalRun(suiteId, {
            label: body?.label,
            modelOverride: body?.modelOverride,
            trials: body?.trials,
            concurrency: body?.concurrency,
            maxTotalCostUsd: body?.maxTotalCostUsd,
            caseIds: body?.caseIds,
            rerunFailedFrom: body?.rerunFailedFrom,
          }),
        {
          body: t.Optional(
            t.Object({
              label: t.Optional(t.String()),
              modelOverride: t.Optional(t.String()),
              trials: t.Optional(t.Number({ minimum: 1, maximum: 10 })),
              concurrency: t.Optional(t.Number({ minimum: 1, maximum: 8 })),
              maxTotalCostUsd: t.Optional(t.Nullable(t.Number({ minimum: 0 }))),
              caseIds: t.Optional(t.Array(t.String())),
              rerunFailedFrom: t.Optional(t.String()),
            }),
          ),
        },
      )
      .get(
        "/api/eval-runs",
        ({ query }) => ({
          runs: svc.listEvalRuns({
            suiteId: query.suiteId || undefined,
            targetKind: query.targetKind,
            targetRef: query.targetRef || undefined,
            limit: parseBoundedLimit(query.limit, 50, 200),
          }),
        }),
        {
          query: t.Object({
            suiteId: t.Optional(t.String()),
            targetKind: t.Optional(
              t.Union([t.Literal("skill"), t.Literal("workflow"), t.Literal("agent")]),
            ),
            targetRef: t.Optional(t.String()),
            limit: t.Optional(t.String()),
          }),
        },
      )
      .get("/api/eval-runs/diff", ({ query }) => svc.diffRuns(query.baseline, query.candidate), {
        query: t.Object({
          baseline: t.String({ minLength: 1 }),
          candidate: t.String({ minLength: 1 }),
        }),
      })
      .get("/api/eval-runs/:evalRunId", ({ params: { evalRunId } }) => svc.getEvalRun(evalRunId))
      .post("/api/eval-runs/:evalRunId/cancel", ({ params: { evalRunId } }) =>
        svc.cancelEvalRun(evalRunId),
      )
      // ─── Feedback & Production-to-Eval Flywheel (ADR 0085 D7) ───
      .get(
        "/api/run-feedback",
        ({ query }) => ({
          feedback: svc.listFeedback({
            runId: query.runId || undefined,
            workflowExecutionId: query.workflowExecutionId || undefined,
            rating: query.rating,
            limit: parseBoundedLimit(query.limit, 100, 500),
          }),
        }),
        {
          query: t.Object({
            runId: t.Optional(t.String()),
            workflowExecutionId: t.Optional(t.String()),
            rating: t.Optional(t.Union([t.Literal("up"), t.Literal("down")])),
            limit: t.Optional(t.String()),
          }),
        },
      )
      .post(
        "/api/run-feedback",
        ({ body }) => ({
          feedback: svc.saveFeedback({
            feedbackId: body.feedbackId,
            runId: body.runId,
            workflowExecutionId: body.workflowExecutionId,
            rating: body.rating,
            tags: body.tags,
            note: body.note,
          }),
        }),
        {
          body: t.Object({
            feedbackId: t.Optional(t.String()),
            runId: t.Optional(t.String()),
            workflowExecutionId: t.Optional(t.String()),
            rating: t.Union([t.Literal("up"), t.Literal("down")]),
            tags: t.Optional(t.Array(t.String())),
            note: t.Optional(t.Nullable(t.String())),
          }),
        },
      )
      .post(
        "/api/run-feedback/promote",
        ({ body }) =>
          svc.promoteToEvalCase({
            runId: body.runId,
            workflowExecutionId: body.workflowExecutionId,
            suiteId: body.suiteId,
            suiteName: body.suiteName,
            caseId: body.caseId,
            caseName: body.caseName,
            tags: body.tags,
            note: body.note,
            expectedContains: body.expectedContains,
          }),
        {
          body: t.Object({
            runId: t.Optional(t.String()),
            workflowExecutionId: t.Optional(t.String()),
            suiteId: t.String({ minLength: 1 }),
            suiteName: t.Optional(t.String()),
            caseId: t.Optional(t.String()),
            caseName: t.Optional(t.String()),
            tags: t.Optional(t.Array(t.String())),
            note: t.Optional(t.String()),
            expectedContains: t.Optional(t.String()),
          }),
        },
      )
  );
}
