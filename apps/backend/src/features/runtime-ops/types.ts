import type * as schema from "../../infra/db/schema.js";

// ─── Types derived from drizzle table $inferSelect/$inferInsert ───
// drizzle tables are the Typescript truth source.
// drizzle-zod schemas provide RUNTIME validation (JSON.parse transforms, .safeParse).
// drizzle-zod's BuildSchema<> isn't ZodType, so z.infer<> is incompatible — $inferSelect is.

export type IssueEventKind =
  | "created"
  | "started"
  | "run.started"
  | "run.ended"
  | "deliverable.submitted"
  | "status.advanced"
  | "human.decided";

export type IssueEvent = Omit<typeof schema.issueEvent.$inferSelect, "kind" | "payload"> & {
  kind: IssueEventKind;
  payload: Record<string, unknown>;
};

export type ControlPlaneEventKind = "projection_degraded" | "retry_requested" | "retry_started";

export type ControlPlaneEvent = Omit<
  typeof schema.controlPlaneEvent.$inferSelect,
  "kind" | "payload"
> & {
  kind: ControlPlaneEventKind;
  payload: Record<string, unknown>;
};

export type SpanOriginKind = "manual" | "cron" | "orchestrator";

export type SpanOriginRow = typeof schema.spanOrigin.$inferSelect;
export type SpanOriginInsert = typeof schema.spanOrigin.$inferInsert;

export type SurfaceHealthRow = Omit<typeof schema.surfaceHealth.$inferSelect, "payload"> & {
  payload: Record<string, unknown>;
};
