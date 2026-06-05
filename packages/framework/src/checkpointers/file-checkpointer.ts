import type { Message } from "@my-agent-team/core";
import type { Checkpointer } from "../checkpointer.js";

export function fileCheckpointer(options: { path: string }): Checkpointer {
  const { path } = options;

  return {
    async load(_threadId) {
      const file = Bun.file(path);
      if (!(await file.exists())) return null;
      const data = await file.json();
      return (data as { messages: Message[] }).messages;
    },
    async save(_threadId, messages) {
      await Bun.write(path, JSON.stringify({ messages }));
    },
  };
}
