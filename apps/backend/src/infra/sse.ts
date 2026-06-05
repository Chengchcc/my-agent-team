import type { AgentEvent } from "@my-agent-team/framework";

export function writeSseEvent(
  controller: ReadableStreamDefaultController,
  event: AgentEvent,
): void {
  controller.enqueue(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
}

export function writeSseDone(controller: ReadableStreamDefaultController): void {
  controller.enqueue("event: done\ndata: {}\n\n");
}
