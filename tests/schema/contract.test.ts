/**
 * Contract tests for ControlPlane + DataPlane JSON Schema validation.
 *
 * Validates that sample request params, response results, and event payloads
 * conform to the schemas defined in docs/architecture/schema/.
 *
 * Uses structural validation — checks required properties, types, enums,
 * and nested objects — without pulling in a full JSON Schema validator.
 */

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Schema loading
// ---------------------------------------------------------------------------

const SCHEMA_DIR = path.resolve(
  import.meta.dir,
  "../../docs/architecture/schema",
);

const cpSchema = JSON.parse(
  fs.readFileSync(path.join(SCHEMA_DIR, "controlplane-methods.schema.json"), "utf-8"),
) as Record<string, unknown>;

const dpSchema = JSON.parse(
  fs.readFileSync(path.join(SCHEMA_DIR, "dataplane-events.schema.json"), "utf-8"),
) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Lightweight structural validators
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

function schemaError(msg: string): never {
  throw new Error(`Schema validation failed: ${msg}`);
}

/** Resolve a $ref like "#/$defs/params/hello" to the actual sub-schema. */
function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  if (!ref.startsWith("#/")) {
    schemaError(`Unsupported $ref: ${ref}`);
  }
  const parts = ref.slice(2).split("/");
  let current: unknown = root;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) {
      schemaError(`Cannot resolve $ref ${ref} — ${part} is not an object`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current !== "object" || current === null) {
    schemaError(`$ref ${ref} resolved to non-object`);
  }
  return current as JsonSchema;
}

/** Validate a value against a JSON Schema (subset). */
function validateValue(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema,
  path: string,
): void {
  // $ref
  if (schema.$ref) {
    validateValue(value, resolveRef(root, schema.$ref as string), root, path);
    return;
  }

  // Handle anyOf / oneOf / allOf
  for (const kw of ["allOf", "anyOf"]) {
    if (schema[kw]) {
      const subschemas = schema[kw] as JsonSchema[];
      for (const sub of subschemas) {
        try {
          validateValue(value, sub, root, `${path}.${kw}`);
        } catch {
          if (kw === "allOf") throw new Error(`allOf failed at ${path}`);
          continue;
        }
        if (kw === "anyOf") return;
      }
      if (kw === "anyOf") schemaError(`${path}: no anyOf subschema matched`);
      return; // allOf all passed
    }
  }

  if (schema.oneOf) {
    const subschemas = schema.oneOf as JsonSchema[];
    for (const sub of subschemas) {
      try {
        validateValue(value, sub, root, `${path}.oneOf`);
        return; // first match wins
      } catch {
        continue;
      }
    }
    schemaError(`${path}: no oneOf subschema matched`);
  }

  // if/then
  if (schema.if) {
    try {
      validateValue(value, schema.if as JsonSchema, root, `${path}.if`);
      if (schema.then) {
        validateValue(value, schema.then as JsonSchema, root, `${path}.then`);
      }
    } catch {
      if (schema.else) {
        validateValue(value, schema.else as JsonSchema, root, `${path}.else`);
      }
    }
    return;
  }

  // Null check
  if (value === null) {
    if (schema.type && !(schema.type as string | string[]).includes("null")) {
      schemaError(`${path}: expected type ${JSON.stringify(schema.type)}, got null`);
    }
    return;
  }

  // Type check
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const jsType = Array.isArray(value) ? "array" : typeof value;
    if (!allowed.includes(jsType)) {
      schemaError(
        `${path}: expected type ${JSON.stringify(allowed)}, got ${jsType}`,
      );
    }
  }

  // const
  if (schema.const !== undefined && value !== schema.const) {
    schemaError(
      `${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`,
    );
  }

  // enum
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) {
    schemaError(
      `${path}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`,
    );
  }

  // Object validation
  if (typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;

    // required
    if (schema.required) {
      for (const req of schema.required as string[]) {
        if (!(req in obj)) {
          schemaError(`${path}: missing required property "${req}"`);
        }
      }
    }

    // properties
    if (schema.properties) {
      const props = schema.properties as Record<string, JsonSchema>;
      for (const [key, propSchema] of Object.entries(props)) {
        if (key in obj) {
          validateValue(obj[key], propSchema, root, `${path}.${key}`);
        }
      }
    }

    // additionalProperties: false
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties as object));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
          schemaError(
            `${path}: unknown property "${key}" (additionalProperties: false)`,
          );
        }
      }
    }

    // additionalProperties as schema (for map-like objects)
    if (
      typeof schema.additionalProperties === "object" &&
      schema.additionalProperties !== null
    ) {
      const valueSchema = schema.additionalProperties as JsonSchema;
      const known = schema.properties ? new Set(Object.keys(schema.properties as object)) : new Set<string>();
      for (const [key, val] of Object.entries(obj)) {
        if (!known.has(key)) {
          validateValue(val, valueSchema, root, `${path}.${key}`);
        }
      }
    }
  }

  // Array validation
  if (Array.isArray(value)) {
    if (schema.items) {
      const itemSchema = schema.items as JsonSchema;
      for (let i = 0; i < value.length; i++) {
        validateValue(value[i], itemSchema, root, `${path}[${i}]`);
      }
    }
    if (schema.minItems !== undefined && value.length < (schema.minItems as number)) {
      schemaError(`${path}: array length ${value.length} < minItems ${schema.minItems}`);
    }
  }

  // String constraints
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < (schema.minLength as number)) {
      schemaError(`${path}: string length ${value.length} < minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > (schema.maxLength as number)) {
      schemaError(`${path}: string length ${value.length} > maxLength ${schema.maxLength}`);
    }
  }

  // Number constraints
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < (schema.minimum as number)) {
      schemaError(`${path}: ${value} < minimum ${schema.minimum}`);
    }
  }
}

/**
 * Validate request params against the schema for a given method.
 */
function validateRequestParams(method: string, params: Record<string, unknown>): void {
  const paramsSchema = resolveRef(
    cpSchema,
    `#/$defs/params/${method}`,
  );
  validateValue(params, paramsSchema, cpSchema, `params.${method}`);
}

/**
 * Validate a success response result against the schema for a given method.
 */
function validateResponseResult(method: string, result: Record<string, unknown>): void {
  const resultSchema = resolveRef(
    cpSchema,
    `#/$defs/results/${method}`,
  );
  validateValue(result, resultSchema, cpSchema, `results.${method}`);
}

/**
 * Validate a DataPlane event payload against the schema for a given event type.
 */
function validateEventPayload(type: string, payload: Record<string, unknown>): void {
  const payloadSchema = resolveRef(
    dpSchema,
    `#/$defs/payloads/${type}`,
  );
  validateValue(payload, payloadSchema, dpSchema, `payloads.${type}`);
}

// ---------------------------------------------------------------------------
// ControlPlane — Request Params Tests
// ---------------------------------------------------------------------------

describe("ControlPlane request params", () => {
  describe("hello", () => {
    test("accepts valid hello params", () => {
      validateRequestParams("hello", { protocolVersion: "lobster-cp/1.0" });
    });

    test("rejects missing protocolVersion", () => {
      expect(() =>
        validateRequestParams("hello", {} as Record<string, unknown>),
      ).toThrow('missing required property "protocolVersion"');
    });

    test("rejects extra properties", () => {
      expect(() =>
        validateRequestParams("hello", {
          protocolVersion: "lobster-cp/1.0",
          extra: "nope",
        }),
      ).toThrow('unknown property "extra"');
    });
  });

  describe("session.list", () => {
    test("accepts empty params", () => {
      validateRequestParams("session.list", {});
    });

    test("accepts filter by status", () => {
      validateRequestParams("session.list", { filter: { status: "idle" } });
    });

    test("rejects invalid filter status", () => {
      expect(() =>
        validateRequestParams("session.list", {
          filter: { status: "bogus" },
        }),
      ).toThrow("not in enum");
    });
  });

  describe("session.create", () => {
    test("accepts with label", () => {
      validateRequestParams("session.create", { label: "debug session" });
    });

    test("accepts empty params", () => {
      validateRequestParams("session.create", {});
    });
  });

  describe("session.attach", () => {
    test("accepts valid attach params", () => {
      validateRequestParams("session.attach", {
        sessionId: "sess_abc",
        frontendId: "tui_1",
      });
    });

    test("rejects missing sessionId", () => {
      expect(() =>
        validateRequestParams("session.attach", {
          frontendId: "tui_1",
        } as Record<string, unknown>),
      ).toThrow('missing required property "sessionId"');
    });
  });

  describe("session.resume", () => {
    test("accepts with sessionId only", () => {
      validateRequestParams("session.resume", { sessionId: "sess_abc" });
    });

    test("accepts with cursor", () => {
      validateRequestParams("session.resume", {
        sessionId: "sess_abc",
        cursor: 42,
      });
    });
  });

  describe("session.close", () => {
    test("accepts valid close params", () => {
      validateRequestParams("session.close", { sessionId: "sess_abc" });
    });
  });

  describe("input.send", () => {
    test("accepts minimal send", () => {
      validateRequestParams("input.send", {
        sessionId: "sess_abc",
        message: "Hello, world!",
      });
    });

    test("accepts with attachments", () => {
      validateRequestParams("input.send", {
        sessionId: "sess_abc",
        message: "Check this file",
        attachments: [
          { name: "readme.txt", mimeType: "text/plain", path: "/tmp/readme.txt" },
        ],
      });
    });

    test("accepts with thinkingBudget", () => {
      validateRequestParams("input.send", {
        sessionId: "sess_abc",
        message: "Complex question",
        thinkingBudget: 16000,
      });
    });
  });

  describe("permission.resolve", () => {
    test("accepts allow decision", () => {
      validateRequestParams("permission.resolve", {
        sessionId: "sess_abc",
        requestId: "perm_1",
        decision: "allow",
        reason: "Looks safe",
      });
    });

    test("accepts deny decision", () => {
      validateRequestParams("permission.resolve", {
        sessionId: "sess_abc",
        requestId: "perm_1",
        decision: "deny",
      });
    });

    test("rejects invalid decision", () => {
      expect(() =>
        validateRequestParams("permission.resolve", {
          sessionId: "sess_abc",
          requestId: "perm_1",
          decision: "maybe",
        } as Record<string, unknown>),
      ).toThrow("not in enum");
    });
  });

  describe("mcp.add", () => {
    test("accepts minimal add", () => {
      validateRequestParams("mcp.add", {
        name: "filesystem",
        command: "npx",
      });
    });

    test("accepts with args and env", () => {
      validateRequestParams("mcp.add", {
        name: "filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        env: { HOME: "/home/user" },
      });
    });
  });

  describe("identity.set", () => {
    test("accepts identity diff", () => {
      validateRequestParams("identity.set", {
        diff: {
          tone: "professional",
          constraints: ["be concise", "prefer code examples"],
        },
      });
    });
  });

  describe("evolution.list", () => {
    test("accepts with status filter", () => {
      validateRequestParams("evolution.list", { status: "pending" });
    });

    test("accepts empty params", () => {
      validateRequestParams("evolution.list", {});
    });
  });
});

// ---------------------------------------------------------------------------
// ControlPlane — Response Result Tests
// ---------------------------------------------------------------------------

describe("ControlPlane response results", () => {
  describe("hello", () => {
    test("accepts valid hello result", () => {
      validateResponseResult("hello", {
        protocol: "lobster-cp/1.0",
        version: "2.0.0",
        uptime: 3600,
        sessionCount: 3,
      });
    });

    test("rejects missing fields", () => {
      expect(() =>
        validateResponseResult("hello", {
          protocol: "lobster-cp/1.0",
          version: "2.0.0",
        } as Record<string, unknown>),
      ).toThrow('missing required property "uptime"');
    });
  });

  describe("session.list", () => {
    test("accepts valid session list", () => {
      validateResponseResult("session.list", {
        sessions: [
          {
            id: "sess_1",
            label: "Debugging",
            status: "running",
            createdAt: "2026-05-17T10:00:00Z",
            frontends: ["tui_1"],
          },
          {
            id: "sess_2",
            status: "idle",
            createdAt: "2026-05-17T09:00:00Z",
            frontends: [],
          },
        ],
      });
    });
  });

  describe("session.create", () => {
    test("accepts valid create result", () => {
      validateResponseResult("session.create", {
        sessionId: "sess_new",
        label: "New session",
        createdAt: "2026-05-17T12:00:00Z",
      });
    });
  });

  describe("system.health", () => {
    test("accepts healthy status", () => {
      validateResponseResult("system.health", {
        status: "healthy",
        uptime: 86400,
        memory: { heapUsed: 50_000_000, heapTotal: 200_000_000 },
        sessionCount: 5,
        activeTurns: 2,
      });
    });

    test("accepts degraded status", () => {
      validateResponseResult("system.health", {
        status: "degraded",
        uptime: 100,
        memory: { heapUsed: 180_000_000, heapTotal: 200_000_000 },
        sessionCount: 1,
        activeTurns: 0,
      });
    });
  });

  describe("identity.get", () => {
    test("accepts full identity result", () => {
      validateResponseResult("identity.get", {
        identity: {
          name: "Codex",
          role: "Senior software engineer",
          tone: "helpful and concise",
          constraints: ["never reveal system internals"],
          preferences: { language: "TypeScript", style: "functional" },
        },
        version: 3,
        updatedAt: "2026-05-16T08:00:00Z",
      });
    });
  });

  describe("evolution.status", () => {
    test("accepts active status", () => {
      validateResponseResult("evolution.status", {
        active: true,
        circuitBreaker: { tripped: false },
        queueSize: 4,
        lastReviewAt: "2026-05-17T11:00:00Z",
      });
    });

    test("accepts tripped circuit breaker", () => {
      validateResponseResult("evolution.status", {
        active: false,
        circuitBreaker: { tripped: true, cooldownRemaining: 1800 },
        queueSize: 10,
      });
    });
  });

  describe("evolution.list", () => {
    test("accepts proposal list", () => {
      validateResponseResult("evolution.list", {
        proposals: [
          {
            id: "prop_1",
            skillName: "git-commit",
            summary: "Automates conventional commit messages",
            status: "pending",
            createdAt: "2026-05-16T12:00:00Z",
          },
          {
            id: "prop_2",
            skillName: "refactor-extract",
            summary: "Extracts function from long file",
            status: "approved",
            createdAt: "2026-05-15T09:00:00Z",
            reviewedAt: "2026-05-16T10:00:00Z",
          },
        ],
      });
    });
  });

  describe("generic OkResult", () => {
    test("session.close returns ok", () => {
      validateResponseResult("session.close", { ok: true });
    });

    test("session.rename returns ok", () => {
      validateResponseResult("session.rename", { ok: true });
    });

    test("input.cancel returns ok", () => {
      validateResponseResult("input.cancel", { ok: true });
    });
  });

  describe("mcp.reload", () => {
    test("accepts with count", () => {
      validateResponseResult("mcp.reload", { ok: true, count: 3 });
    });
  });
});

// ---------------------------------------------------------------------------
// DataPlane — Event Payload Tests
// ---------------------------------------------------------------------------

describe("DataPlane event payloads", () => {
  describe("turn.started", () => {
    test("accepts valid turn start", () => {
      validateEventPayload("turn.started", {
        turnId: "turn_42",
        sessionId: "sess_abc",
        timestamp: "2026-05-17T12:00:00Z",
        userMessage: "Fix the login bug",
      });
    });

    test("accepts sub-turn with parentTurnId", () => {
      validateEventPayload("turn.started", {
        turnId: "subturn_1",
        sessionId: "sess_abc",
        timestamp: "2026-05-17T12:01:00Z",
        parentTurnId: "turn_42",
      });
    });
  });

  describe("assistant.delta", () => {
    test("accepts text delta", () => {
      validateEventPayload("assistant.delta", {
        turnId: "turn_42",
        content: "Here is the fix:",
        contentBlockIndex: 0,
      });
    });

    test("accepts thinking delta", () => {
      validateEventPayload("assistant.delta", {
        turnId: "turn_42",
        content: "Let me analyze the bug...",
        thinking: true,
      });
    });

    test("rejects missing turnId", () => {
      expect(() =>
        validateEventPayload("assistant.delta", {
          content: "text",
        } as Record<string, unknown>),
      ).toThrow('missing required property "turnId"');
    });
  });

  describe("tool.update", () => {
    test("accepts tool started", () => {
      validateEventPayload("tool.update", {
        turnId: "turn_42",
        toolCallId: "tool_1",
        toolName: "read",
        state: "started",
        args: { filePath: "/tmp/test.ts" },
      });
    });

    test("accepts tool completed", () => {
      validateEventPayload("tool.update", {
        turnId: "turn_42",
        toolCallId: "tool_1",
        toolName: "read",
        state: "completed",
        result: { content: "console.log('hello')" },
        duration: 12,
      });
    });
  });

  describe("permission.required", () => {
    test("accepts permission request", () => {
      validateEventPayload("permission.required", {
        sessionId: "sess_abc",
        requestId: "perm_1",
        toolName: "bash",
        args: { command: "rm -rf /tmp/cache" },
        reason: "This command modifies files outside the workspace",
        frontendId: "tui_1",
      });
    });
  });

  describe("user.question", () => {
    test("accepts single-select question", () => {
      validateEventPayload("user.question", {
        sessionId: "sess_abc",
        questionId: "q_1",
        question: "Which linter should I use?",
        options: [
          { label: "ESLint", description: "JavaScript/TypeScript linter" },
          { label: "Biome", description: "Fast, all-in-one toolchain" },
        ],
        multiSelect: false,
      });
    });

    test("accepts multi-select question", () => {
      validateEventPayload("user.question", {
        sessionId: "sess_abc",
        questionId: "q_2",
        question: "Select test frameworks",
        options: [{ label: "Jest" }, { label: "Vitest" }, { label: "Bun" }],
        multiSelect: true,
      });
    });
  });

  describe("turn.completed", () => {
    test("accepts completed with tokens", () => {
      validateEventPayload("turn.completed", {
        turnId: "turn_42",
        duration: 3500,
        tokensUsed: { input: 1200, output: 800, cacheRead: 200 },
        toolCallCount: 3,
      });
    });
  });

  describe("turn.failed", () => {
    test("accepts turn failure", () => {
      validateEventPayload("turn.failed", {
        turnId: "turn_42",
        error: {
          code: "TOKEN_LIMIT_EXCEEDED",
          message: "Context window exceeded",
          details: { current: 250_000, limit: 200_000 },
        },
        duration: 1200,
      });
    });
  });

  describe("state.changed", () => {
    test("accepts idle to running", () => {
      validateEventPayload("state.changed", {
        sessionId: "sess_abc",
        previousState: "idle",
        currentState: "running",
        reason: "Turn started by tui_1",
      });
    });
  });

  describe("attach.changed", () => {
    test("accepts frontend roster", () => {
      validateEventPayload("attach.changed", {
        sessionId: "sess_abc",
        frontends: [
          { id: "tui_1", type: "tui", status: "active" },
          { id: "lark_bot_1", type: "lark", status: "idle" },
        ],
      });
    });
  });

  describe("identity.changed", () => {
    test("accepts identity version update", () => {
      validateEventPayload("identity.changed", {
        version: 4,
        timestamp: "2026-05-17T12:30:00Z",
        previousVersion: 3,
      });
    });
  });

  describe("skills.reloaded", () => {
    test("accepts skill reload", () => {
      validateEventPayload("skills.reloaded", {
        count: 5,
        added: ["git-commit", "refactor-extract"],
        removed: [],
      });
    });
  });

  describe("evolution.progress", () => {
    test("accepts progress event", () => {
      validateEventPayload("evolution.progress", {
        proposalId: "prop_1",
        phase: "analyzing",
        message: "Analyzing trace patterns for git workflow improvements",
      });
    });
  });

  describe("evolution.skillProposed", () => {
    test("accepts skill proposal", () => {
      validateEventPayload("evolution.skillProposed", {
        proposalId: "prop_1",
        skillName: "git-commit",
        summary: "Automated conventional commit message generation",
        category: "git",
      });
    });
  });

  describe("system.warn", () => {
    test("accepts info severity", () => {
      validateEventPayload("system.warn", {
        code: "MEMORY_HIGH",
        message: "Heap usage above 80%",
        severity: "warn",
        details: { heapUsed: 180_000_000, heapTotal: 200_000_000 },
      });
    });

    test("accepts error severity", () => {
      validateEventPayload("system.warn", {
        code: "MCP_CONNECTION_LOST",
        message: "MCP server 'filesystem' disconnected",
        severity: "error",
        timestamp: "2026-05-17T12:00:00Z",
      });
    });
  });

  describe("snapshot", () => {
    test("accepts session snapshot", () => {
      validateEventPayload("snapshot", {
        turns: [
          {
            turnId: "turn_1",
            status: "completed",
            startedAt: "2026-05-17T10:00:00Z",
            userMessage: "Hello",
            assistantMessage: "Hi!",
            completedAt: "2026-05-17T10:00:05Z",
            duration: 5000,
            tokensUsed: { input: 100, output: 50 },
            toolCalls: [],
          },
          {
            turnId: "turn_2",
            status: "running",
            startedAt: "2026-05-17T12:00:00Z",
            toolCalls: [
              { toolCallId: "tc_1", toolName: "read", state: "running" },
            ],
          },
        ],
        cursor: 150,
      });
    });
  });
});
