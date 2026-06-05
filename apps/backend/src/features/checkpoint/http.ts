function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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
