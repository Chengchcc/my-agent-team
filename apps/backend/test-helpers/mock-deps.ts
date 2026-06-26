/* eslint-disable @typescript-eslint/no-explicit-any */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunSupervisor } from "../src/features/run/supervisor.js";

/** Create a shared test directory for the whole test suite. */
const TEST_ROOT = join(tmpdir(), `agent-team-test-${Date.now()}`);
mkdirSync(TEST_ROOT, { recursive: true });

export function testDir(...parts: string[]): string {
  const p = join(TEST_ROOT, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
}

export function testDB(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  return db;
}

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
    heartbeatTimeoutMs: 30000,
    heartbeatIntervalMs: 5000,
    stepStallTimeoutMs: 120_000,
    cancelGraceMs: 5000,
    maxConcurrentRuns: 8,
    shutdownTimeoutMs: 5000,
  };
}

export function mockOpsStore() {
  return {
    insertRunOrigin: () => {},
    getRunOrigin: () => null,
    appendRunEvent: () => {},
  };
}

export function mockAgentSvc() {
  return {
    getById: async () => ({
      modelName: "claude",
      modelProvider: "anthropic",
      modelBaseUrl: null,
      permissionMode: "ask",
      maxSteps: null,
    }),
    exists: async () => true,
  };
}

export function mockSupervisor(db: Database): RunSupervisor {
  return new RunSupervisor({
    config: mockConfig(),
    eventLog: {
      append: async () => {},
      read: async () => [] as any[],
      subscribe: () => ({}) as any,
    } as any,
    opsStore: mockOpsStore() as any,
    tracer: {
      inject: () => ({ traceId: "", traceparent: "" }),
      startSpan: () => ({}),
      currentTrace: () => null,
      link: () => {},
    } as any,
    db,
    onReap: () => {},
  });
}

let _idCount = 0;
export function testIdGen(): string {
  return `test-id-${_idCount++}`;
}

export async function waitForFinalize(
  s: RunSupervisor,
  runId: string,
  timeout = 5000,
): Promise<void> {
  const start = Date.now();
  while (s.getActive().has(runId) && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 50));
  }
}
