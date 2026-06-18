import { z } from "zod";
import { json } from "../../http/response.js";
import { ISSUE_STATUSES } from "../orchestrator/transitions.js";
import { type IssueStatus } from "./entities.js";
import type { IssueRow } from "./entities.js";
import {
  IllegalTransitionError,
  IssueNotFoundError,
  type IssueService,
  ValidationError,
} from "./service.js";

const createSchema = z.object({
  projectId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  threadId: z.string().trim().min(1),
});

const transitionSchema = z.object({ to: z.enum(ISSUE_STATUSES as readonly [string, ...string[]]) });

export function issueRoutes(
  svc: IssueService,
  opts?: { onIssueCreated?: (issue: IssueRow) => Promise<unknown> },
) {
  const { onIssueCreated } = opts ?? {};

  return {
    /** POST /api/issues → 201 { issue } */
    async create(req: Request): Promise<Response> {
      const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success)
        return json({ error: "Validation failed", details: parsed.error.issues }, 400);
      try {
        const issue = svc.createIssue(parsed.data);
        // M18.2: best-effort start first step — failure does not block create response
        void onIssueCreated?.(issue).catch((e) =>
          console.error(`[orchestrator] startStep failed for ${issue.issueId}: ${String(e)}`),
        );
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
        return json({ issue: svc.applyTransition(issueId, parsed.data.to as IssueStatus) });
      } catch (err) {
        if (err instanceof IssueNotFoundError) return json({ error: err.message }, 404);
        if (err instanceof IllegalTransitionError) return json({ error: err.message }, 409);
        throw err;
      }
    },

    /** GET /api/issue-meta → 200 { statuses } */
    meta(): Response {
      return json({ statuses: ISSUE_STATUSES });
    },
  };
}
