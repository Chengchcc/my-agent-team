import { describe, expect, test } from "bun:test";
import { AgentSpecV1, CURRENT_SCHEMA_VERSION } from "./index.js";

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
});
