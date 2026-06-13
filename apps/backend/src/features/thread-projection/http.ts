import { json } from "../../http/response.js";

import type { ThreadProjectionService } from "./service.js";

export function threadProjectionRoutes(svc: ThreadProjectionService) {
  return {
    async getMessages(_req: Request, threadId: string): Promise<Response> {
      const messages = await svc.getMessages(threadId);
      return json({ threadId, messages });
    },
  };
}
