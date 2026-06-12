import { describe, expect, test } from "bun:test";
import { AgentSpecV1, AgentSpecV2, CURRENT_SCHEMA_VERSION } from "./index.js";

const validSpec = {
  schemaVersion: "1" as const,
  workspace: "/tmp/workspace",
  threadId: "thread-1",
  model: {
    provider: "anthropic" as const,
    model: "claude-sonnet-4-6",
  },
  input: "Hello, world!",
};

describe("AgentSpecV1", () => {
  test("parses a valid minimal spec successfully", () => {
    const result = AgentSpecV1.parse(validSpec);
    expect(result.schemaVersion).toBe("1");
    expect(result.workspace).toBe("/tmp/workspace");
    expect(result.threadId).toBe("thread-1");
    expect(result.model.provider).toBe("anthropic");
    expect(result.model.model).toBe("claude-sonnet-4-6");
    expect(result.input).toBe("Hello, world!");
    expect(result.apiKey).toBeUndefined();
    expect(result.permissionMode).toBeUndefined();
    expect(result.maxSteps).toBeUndefined();
  });

  test("parses a full spec with all optional fields", () => {
    const fullSpec = {
      ...validSpec,
      apiKey: "sk-ant-123",
      permissionMode: "ask" as const,
      maxSteps: 10,
      model: {
        ...validSpec.model,
        baseURL: "https://api.example.com",
      },
    };
    const result = AgentSpecV1.parse(fullSpec);
    expect(result.apiKey).toBe("sk-ant-123");
    expect(result.permissionMode).toBe("ask");
    expect(result.maxSteps).toBe(10);
    expect(result.model.baseURL).toBe("https://api.example.com");
  });

  test("fails when schemaVersion is missing", () => {
    const { schemaVersion: _, ...without } = validSpec;
    expect(() => AgentSpecV1.parse(without)).toThrow();
  });

  test("fails when schemaVersion is '2' (unknown version)", () => {
    expect(() => AgentSpecV1.parse({ ...validSpec, schemaVersion: "2" })).toThrow();
  });

  test("fails when input is missing", () => {
    const { input: _, ...without } = validSpec;
    expect(() => AgentSpecV1.parse(without)).toThrow();
  });

  test("fails when model.baseURL is not a valid URL", () => {
    expect(() =>
      AgentSpecV1.parse({
        ...validSpec,
        model: { ...validSpec.model, baseURL: "not-a-url" },
      }),
    ).toThrow();
  });

  test("fails when maxSteps is negative", () => {
    expect(() => AgentSpecV1.parse({ ...validSpec, maxSteps: -1 })).toThrow();
  });

  test("fails when maxSteps is not an integer", () => {
    expect(() => AgentSpecV1.parse({ ...validSpec, maxSteps: 1.5 })).toThrow();
  });

  test("fails when permissionMode is not an allowed enum value", () => {
    expect(() => AgentSpecV1.parse({ ...validSpec, permissionMode: "always" })).toThrow();
  });

  test("succeeds when apiKey is absent (optional field)", () => {
    const result = AgentSpecV1.parse(validSpec);
    expect(result.apiKey).toBeUndefined();
  });

  test("fails when workspace is empty string", () => {
    expect(() => AgentSpecV1.parse({ ...validSpec, workspace: "" })).toThrow();
  });

  test("fails when threadId is empty string", () => {
    expect(() => AgentSpecV1.parse({ ...validSpec, threadId: "" })).toThrow();
  });

  test("CURRENT_SCHEMA_VERSION equals '1'", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe("1");
  });

  // ─── M9 durable run fields ─────────────────────────────────────

  test("parses spec with M9 durable fields (runId, attemptId, mode, storage)", () => {
    const spec = {
      ...validSpec,
      runId: "run-1",
      attemptId: "att-1",
      mode: "run" as const,
      storage: {
        eventLog: { kind: "sqlite" as const, path: "/tmp/events.db" },
        checkpointer: { kind: "sqlite" as const, path: "/tmp/check.db" },
      },
    };
    const parsed = AgentSpecV1.parse(spec);
    expect(parsed.runId).toBe("run-1");
    expect(parsed.attemptId).toBe("att-1");
    expect(parsed.mode).toBe("run");
    expect(parsed.storage?.eventLog?.kind).toBe("sqlite");
    expect(parsed.storage?.eventLog?.path).toBe("/tmp/events.db");
    expect(parsed.storage?.checkpointer?.kind).toBe("sqlite");
  });

  test("mode defaults to 'run' when omitted", () => {
    const parsed = AgentSpecV1.parse(validSpec);
    expect(parsed.mode).toBe("run");
  });

  test("parses resume mode with resumeCommand", () => {
    const spec = {
      ...validSpec,
      mode: "resume" as const,
      resumeCommand: { approved: true, message: "go ahead" },
    };
    const parsed = AgentSpecV1.parse(spec);
    expect(parsed.mode).toBe("resume");
    expect(parsed.resumeCommand?.approved).toBe(true);
    expect(parsed.resumeCommand?.message).toBe("go ahead");
  });

  test("fails when mode=resume but resumeCommand is missing", () => {
    const spec = { ...validSpec, mode: "resume" as const };
    expect(() => AgentSpecV1.parse(spec)).toThrow();
  });

  test("storage is optional (old specs still valid)", () => {
    const parsed = AgentSpecV1.parse(validSpec);
    expect(parsed.storage).toBeUndefined();
  });

  test("storage.checkpointer accepts memory kind without path", () => {
    const spec = {
      ...validSpec,
      storage: {
        checkpointer: { kind: "memory" as const },
      },
    };
    const parsed = AgentSpecV1.parse(spec);
    expect(parsed.storage?.checkpointer?.kind).toBe("memory");
    expect(parsed.storage?.checkpointer?.path).toBeUndefined();
  });

  test("fails when runId is empty string", () => {
    expect(() => AgentSpecV1.parse({ ...validSpec, runId: "" })).toThrow();
  });

  test("fails when mode is invalid", () => {
    expect(() => AgentSpecV1.parse({ ...validSpec, mode: "restart" })).toThrow();
  });

  // ─── M10 conversation fields ──────────────────────────────────

  test("parses spec with conversationId and senderMemberId", () => {
    const spec = {
      ...validSpec,
      conversationId: "conv-1",
      senderMemberId: "mem-x1",
    };
    const parsed = AgentSpecV1.parse(spec);
    expect(parsed.conversationId).toBe("conv-1");
    expect(parsed.senderMemberId).toBe("mem-x1");
  });

  test("conversationId and senderMemberId are optional (old specs still valid)", () => {
    const parsed = AgentSpecV1.parse(validSpec);
    expect(parsed.conversationId).toBeUndefined();
    expect(parsed.senderMemberId).toBeUndefined();
  });

  test("fails when senderMemberId present but conversationId missing", () => {
    const spec = { ...validSpec, senderMemberId: "mem-x1" };
    expect(() => AgentSpecV1.parse(spec)).toThrow();
  });

  test("conversationId without senderMemberId is fine", () => {
    const spec = { ...validSpec, conversationId: "conv-1" };
    const parsed = AgentSpecV1.parse(spec);
    expect(parsed.conversationId).toBe("conv-1");
    expect(parsed.senderMemberId).toBeUndefined();
  });

  test("fails when conversationId is empty string", () => {
    expect(() => AgentSpecV1.parse({ ...validSpec, conversationId: "" })).toThrow();
  });

  test("fails when senderMemberId is empty string", () => {
    expect(() =>
      AgentSpecV1.parse({ ...validSpec, senderMemberId: "", conversationId: "conv-1" }),
    ).toThrow();
  });
});

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
