import { describe, expect, test } from "bun:test";
import { createCheckpointService } from "./service.js";

describe("CheckpointService", () => {
  test("getMessages parses JSON from port", async () => {
    const svc = createCheckpointService({
      port: {
        async getMessages(threadId) {
          return threadId === "th-1" ? [{ role: "user", content: "hi" }] : null;
        },
      },
    });

    const msgs = await svc.getMessages("th-1");
    expect(msgs).toEqual([{ role: "user", content: "hi" }]);
  });

  test("getMessages returns empty array for unknown thread", async () => {
    const svc = createCheckpointService({
      port: {
        async getMessages(_threadId) { return null; },
      },
    });

    const msgs = await svc.getMessages("unknown");
    expect(msgs).toEqual([]);
  });
});
