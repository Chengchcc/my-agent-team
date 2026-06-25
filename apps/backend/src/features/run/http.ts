import { z } from "zod";
import { json, parseJsonBody } from "../../http/response.js";
import { getSession } from "./session-registry.js";

const resumeSchema = z.object({ approved: z.boolean(), message: z.string().optional() });

/** Resume an interrupted run via AgentSession.resume().
 *  Looks up the session by runId from the in-memory registry. */
export function resumeRoute() {
  return async (req: Request, runId: string): Promise<Response> => {
    const body = await parseJsonBody(req);
    if ("error" in body) return body.error;
    const parsed = resumeSchema.safeParse(body.data);
    if (!parsed.success)
      return json({ error: "Validation failed", details: parsed.error.issues }, 400);

    const session = getSession(runId);
    if (!session) return json({ error: "Session not found — run may have already completed" }, 404);

    try {
      await session.resume({ approved: parsed.data.approved, message: parsed.data.message });
      return json({ runId, resumed: true }, 202);
    } catch (err) {
      return json({ error: (err as Error).message }, 500);
    }
  };
}
