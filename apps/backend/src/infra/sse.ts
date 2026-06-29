import type { AgentEvent } from "@my-agent-team/framework";

export function writeSseEvent(
  controller: ReadableStreamDefaultController,
  event: AgentEvent,
): void {
  const { type, ...data } = event as Record<string, unknown>;
  controller.enqueue(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function writeSseDone(controller: ReadableStreamDefaultController): void {
  controller.enqueue("event: done\ndata: {}\n\n");
}
