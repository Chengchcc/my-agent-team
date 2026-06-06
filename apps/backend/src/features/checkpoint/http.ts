import { json } from "../../http/response.js";

export function checkpointRoutes(
  svc: ReturnType<typeof import("./service.js").createCheckpointService>,
) {
  return {
    async getMessages(_req: Request, threadId: string): Promise<Response> {
      const messages = await svc.getMessages(threadId);
      return json({ threadId, messages });
    },
  };
}
