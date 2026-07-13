import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatModel } from "@my-agent-team/core";
import { type EchoScript, echoModel } from "@my-agent-team/test-helpers";
import type { SpanSupervisor } from "../src/features/span/supervisor.js";
import { openDb } from "../src/infra/sqlite/db.js";

// ═══════════════════════════════════════════════════════════════
// Test directory & db
// ═══════════════════════════════════════════════════════════════

/** Create a shared test directory for the whole test suite. */
const TEST_ROOT = join(tmpdir(), `agent-team-test-${Date.now()}`);
mkdirSync(TEST_ROOT, { recursive: true });

export function testDir(...parts: string[]): string {
  const p = join(TEST_ROOT, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
}

export function testDB(): Database {
  // S1: events.db merged into backend.db - openDb runs unified migration (all tables).
  return openDb(":memory:");
}

/** Like testDB but also runs the main backend drizzle migrations (schema.ts -> issue table etc). */
export function testMainDB(): Database {
  return openDb(":memory:");
}

// ═══════════════════════════════════════════════════════════════
// Mock config
// ═══════════════════════════════════════════════════════════════

export function mockConfig() {
  const dir = testDir();
  return {
    dataDir: dir,
    workspaceRoot: join(dir, "workspaces"),
    templateDir: join(dir, "templates"),
    anthropicApiKey: "test",
    port: 0,
    host: "",
    authToken: "",
    reaperIntervalMs: 0,
    stepStallTimeoutMs: 120_000,
    cancelGraceMs: 5000,
    maxConcurrentRuns: 8,
    shutdownTimeoutMs: 5000,
    builtinSkillsDir: join(dir, "builtin-skills-test"),
  };
}

// ═══════════════════════════════════════════════════════════════
// TID - centralized test ID generation
// ═══════════════════════════════════════════════════════════════

export const TID = {
  conversation: (s = "c1") => s,
  /** sessionId formula: context:agent */
  session: (ctx = "c1", agent = "a1") => `${ctx}:${agent}`,
  /** Phase 5 unified format (same shape as session, semantically distinct) */
  issueSession: (issue: string, agent: string) => `${issue}:${agent}`,
  run: (s = "r1") => s,
  /** spanId = current spanId (product semantics: one prompt loop). */
  span: (s = "sp1") => s,
};

// ═══════════════════════════════════════════════════════════════
// testIdGen
// ═══════════════════════════════════════════════════════════════

let _idCount = 0;
export function testIdGen(): string {
  return `test-id-${_idCount++}`;
}

// ═══════════════════════════════════════════════════════════════
// waitForFinalize
// ═══════════════════════════════════════════════════════════════

export async function waitForFinalize(
  s: SpanSupervisor,
  spanId: string,
  timeout = 5000,
): Promise<void> {
  const start = Date.now();
  while (s.getActive().has(spanId) && Date.now() - start < timeout) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
  }
}

// ═══════════════════════════════════════════════════════════════
// fakeModel (C - scripted ChatModel for deterministic tests)
// ═══════════════════════════════════════════════════════════════

const DEFAULT_ECHO_SCRIPT: EchoScript = { turns: [{ type: "text", text: "ok" }] };

/** Return an echoModel preloaded with a default ok-response script.
 *  Pass a custom EchoScript to control the assistant's output. */
export function fakeModel(script?: EchoScript): ChatModel {
  return echoModel(script ?? DEFAULT_ECHO_SCRIPT);
}

// ═══════════════════════════════════════════════════════════════
// fakeProjectSvc (B - data stub for project auto-orchestrate)
// ═══════════════════════════════════════════════════════════════

export function fakeProjectSvc(overrides?: { autoOrchestrate?: boolean; projectId?: string }): {
  getById(id: string): { autoOrchestrate: boolean; projectId: string };
} {
  return {
    getById: (id: string) => ({
      autoOrchestrate: overrides?.autoOrchestrate ?? true,
      projectId: overrides?.projectId ?? id,
    }),
  };
}
