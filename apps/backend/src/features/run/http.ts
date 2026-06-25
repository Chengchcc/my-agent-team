import { z } from "zod";
import { json, parseJsonBody } from "../../http/response.js";
import type { RunSupervisor } from "./supervisor.js";

const resumeSchema = z.object({ approved: z.boolean(), message: z.string().optional() });

/** Minimal resume-only HTTP handler. Run start/cancel are handled by AgentSession,
 *  not HTTP. Resume is still needed for ToolApprovalCard interrupt flow. */
export function resumeRoute(
  supervisor: RunSupervisor,
  getThreadIdForRun: (runId: string) => Promise<string>,
) {
  return async (req: Request, runId: string): Promise<Response> => {
    const body = await parseJsonBody(req);
    if ("error" in body) return body.error;
    const parsed = resumeSchema.safeParse(body.data);
    if (!parsed.success)
      return json({ error: "Validation failed", details: parsed.error.issues }, 400);

    const threadId = await getThreadIdForRun(runId).catch(() => null);
    if (!threadId) return json({ error: "Run not found" }, 404);

    try {
      const { attemptId } = await supervisor.resumeRun(runId, threadId, {
        mode: "resume",
        resumeCommand: parsed.data,
      });
      return json({ runId, attemptId }, 202);
    } catch (err) {
      return json({ error: (err as Error).message }, 500);
    }
  };
}
