import { describe, expect, test } from "bun:test";
import type { AgentFsLike } from "@my-agent-team/core";
import { AgentFS } from "./agent-fs.js";
import { MemoryBackend } from "./backends.js";

// Type-level assertion: AgentFS satisfies AgentFsLike.
// If this compiles, AgentFS has all required methods with matching signatures.
// Delete AgentFS.stat → typecheck fails (negative test, compile-time only).
function _assertSatisfies(_fs: AgentFsLike): void {}

describe("AgentFS ↔ AgentFsLike type contract", () => {
  test("AgentFS satisfies AgentFsLike at the type level", () => {
    const fs = new AgentFS({
      mounts: [{ prefix: "/", backend: new MemoryBackend(), domain: "shared" }],
    });
    _assertSatisfies(fs);
    expect(fs).toBeDefined();
  });
});
