import { describe, expect, test } from "bun:test";
import { AgentSpecV2 } from "./index.js";

// ─── AgentSpecV2 — discriminated union, builder→parse round-trip ────────

const validV2Run = {
  schemaVersion: "2" as const,
  agentId: "agent-1",
  runId: crypto.randomUUID(),
  threadId: "thread-1",
  mode: "run" as const,
  input: "Hello from builder",
  model: { provider: "anthropic" as const, model: "claude-sonnet-4-6" },
};

const validV2Resume = {
  schemaVersion: "2" as const,
  agentId: "agent-1",
  runId: crypto.randomUUID(),
  threadId: "thread-1",
  mode: "resume" as const,
  resumeCommand: { approved: true },
  model: { provider: "anthropic" as const, model: "claude-sonnet-4-6" },
};

const validV2Reflect = {
  schemaVersion: "2" as const,
  agentId: "agent-1",
  runId: crypto.randomUUID(),
  threadId: "reflect:thread-1",
  mode: "reflect" as const,
  input: "reflection guidance",
  parentRunId: crypto.randomUUID(),
  model: { provider: "anthropic" as const, model: "claude-sonnet-4-6" },
};

describe("AgentSpecV2", () => {
  test("safeParse succeeds for run mode (builder output shape)", () => {
    const parsed = AgentSpecV2.safeParse(validV2Run);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const data = parsed.data as { mode: string; input: string };
      expect(data.mode).toBe("run");
      expect(data.input).toBe("Hello from builder");
    }
  });

  test("safeParse succeeds for resume mode", () => {
    const parsed = AgentSpecV2.safeParse(validV2Resume);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const data = parsed.data as { mode: string; resumeCommand: { approved: boolean } };
      expect(data.mode).toBe("resume");
      expect(data.resumeCommand.approved).toBe(true);
    }
  });

  test("safeParse succeeds for reflect mode", () => {
    const parsed = AgentSpecV2.safeParse(validV2Reflect);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const data = parsed.data as { mode: string; parentRunId: string };
      expect(data.mode).toBe("reflect");
      expect(data.parentRunId).toBeDefined();
    }
  });

  test("fails when mode is missing (discriminated union key)", () => {
    const { mode: _, ...noMode } = validV2Run;
    const parsed = AgentSpecV2.safeParse(noMode);
    expect(parsed.success).toBe(false);
  });

  test("fails when run mode missing input", () => {
    const { input: _, ...noInput } = validV2Run;
    const parsed = AgentSpecV2.safeParse(noInput);
    expect(parsed.success).toBe(false);
  });

  test("fails when resume mode missing resumeCommand", () => {
    const { resumeCommand: _, ...noCmd } = validV2Resume;
    const parsed = AgentSpecV2.safeParse(noCmd);
    expect(parsed.success).toBe(false);
  });

  test("fails when reflect mode missing parentRunId", () => {
    const { parentRunId: _, ...noParent } = validV2Reflect;
    const parsed = AgentSpecV2.safeParse(noParent);
    expect(parsed.success).toBe(false);
  });

  test("fails when agentId is empty", () => {
    const parsed = AgentSpecV2.safeParse({ ...validV2Run, agentId: "" });
    expect(parsed.success).toBe(false);
  });

  test("fails when threadId is empty", () => {
    const parsed = AgentSpecV2.safeParse({ ...validV2Run, threadId: "" });
    expect(parsed.success).toBe(false);
  });

  test("fails when runId is empty", () => {
    const parsed = AgentSpecV2.safeParse({ ...validV2Run, runId: "" });
    expect(parsed.success).toBe(false);
  });

  test("fails when model.model is empty", () => {
    const parsed = AgentSpecV2.safeParse({
      ...validV2Run,
      model: { provider: "anthropic", model: "" },
    });
    expect(parsed.success).toBe(false);
  });
});
