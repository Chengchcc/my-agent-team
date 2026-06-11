import { json } from "../../http/response.js";

import type { CheckpointService } from "./service.js";

export function checkpointRoutes(svc: CheckpointService) {
  return {
    async getMessages(_req: Request, threadId: string): Promise<Response> {
      const messages = await svc.getMessages(threadId);
      return json({ threadId, messages });
    },
  };
}
