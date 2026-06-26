import { describe, expect, test } from "bun:test";
import { inMemoryCheckpointer, passthroughContextManager } from "@my-agent-team/framework";
import type { AgentSession } from "@my-agent-team/harness";
import { type EchoScript, echoModel } from "@my-agent-team/test-helpers";
import {
  createSessionFactory,
  type SessionFactory,
  type SessionSpec,
  SessionSpecMismatchError,
} from "./session-factory.js";

const ECHO_SCRIPT: EchoScript = { turns: [{ text: "ok" }] };

function makeSpec(overrides?: Partial<SessionSpec>): SessionSpec {
  return {
    agentId: "a1",
    cwd: "/tmp/test",
    model: echoModel(ECHO_SCRIPT),
    modelName: "claude-test",
    plugins: [],
    tools: [],
    checkpointer: inMemoryCheckpointer(),
    contextManager: passthroughContextManager(),
    ...overrides,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeFactory(opts?: { reaperIntervalMs?: number; idleTimeoutMs?: number }): SessionFactory {
  return createSessionFactory({
    config: { dataDir: "/tmp" } as any,
    reaperIntervalMs: opts?.reaperIntervalMs ?? 0,
    idleTimeoutMs: opts?.idleTimeoutMs ?? 30 * 60_000,
  });
}

function forceSessionState(session: AgentSession, state: string): void {
  const s = session as unknown as Record<string, () => void>;
  Object.defineProperty(session, "state", { value: state, configurable: true });
  if (!s.dispose) s.dispose = () => {};
}

describe("SessionFactory", () => {
  test("getOrCreate returns same instance for same sessionId", () => {
    const f = makeFactory();
    const s1 = f.getOrCreate("sid-1", makeSpec());
    const s2 = f.getOrCreate("sid-1", makeSpec());
    expect(s1).toBe(s2);
    f.disposeAll();
  });

  test("getOrCreate returns different instances for different sessionIds", () => {
    const f = makeFactory();
    const s1 = f.getOrCreate("sid-1", makeSpec());
    const s2 = f.getOrCreate("sid-2", makeSpec());
    expect(s1).not.toBe(s2);
    f.disposeAll();
  });

  test("getOrCreate throws SessionSpecMismatchError on agentId change", () => {
    const f = makeFactory();
    f.getOrCreate("sid-1", makeSpec({ agentId: "a1", modelName: "claude-test" }));
    expect(() =>
      f.getOrCreate("sid-1", makeSpec({ agentId: "a2", modelName: "claude-test" })),
    ).toThrow(SessionSpecMismatchError);
    f.disposeAll();
  });

  test("getOrCreate throws on modelName change", () => {
    const f = makeFactory();
    f.getOrCreate("sid-1", makeSpec({ modelName: "claude-test" }));
    expect(() => f.getOrCreate("sid-1", makeSpec({ modelName: "claude-other" }))).toThrow(
      SessionSpecMismatchError,
    );
    f.disposeAll();
  });

  test("getOrCreate throws on cwd change", () => {
    const f = makeFactory();
    f.getOrCreate("sid-1", makeSpec({ cwd: "/tmp/a" }));
    expect(() => f.getOrCreate("sid-1", makeSpec({ cwd: "/tmp/b" }))).toThrow(
      SessionSpecMismatchError,
    );
    f.disposeAll();
  });

  test("dispose removes session", () => {
    const f = makeFactory();
    f.getOrCreate("sid-1", makeSpec());
    f.dispose("sid-1");
    const s = f.getOrCreate("sid-1", makeSpec());
    expect(s).toBeDefined();
    f.disposeAll();
  });

  test("disposeAll cleans up all sessions", () => {
    const f = makeFactory();
    f.getOrCreate("sid-1", makeSpec());
    f.getOrCreate("sid-2", makeSpec());
    f.disposeAll();
    const s1 = f.getOrCreate("sid-1", makeSpec());
    const s2 = f.getOrCreate("sid-2", makeSpec());
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
    f.disposeAll();
  });

  test("enqueuePrompt serializes concurrent calls on same sessionId", async () => {
    const f = makeFactory();
    f.getOrCreate("sid-1", makeSpec());
    const order: number[] = [];
    const p1 = f.enqueuePrompt("sid-1", "hello").then(() => {
      order.push(1);
    });
    const p2 = f.enqueuePrompt("sid-1", "world").then(() => {
      order.push(2);
    });
    await Promise.all([p1, p2]);
    expect(order.length).toBe(2);
    f.disposeAll();
  });

  test("idle reaper disposes expired sessions", async () => {
    const f = makeFactory({ reaperIntervalMs: 10, idleTimeoutMs: 0 });
    const session = f.getOrCreate("sid-1", makeSpec());
    forceSessionState(session, "idle");
    await new Promise((r) => setTimeout(r, 50));
    const s2 = f.getOrCreate("sid-1", makeSpec());
    expect(s2).toBeDefined();
    f.disposeAll();
  });

  test("idle reaper does not dispose waiting sessions", () => {
    const f = makeFactory({ reaperIntervalMs: 10, idleTimeoutMs: 0 });
    const session = f.getOrCreate("sid-1", makeSpec());
    forceSessionState(session, "waiting");
    const s2 = f.getOrCreate("sid-1", makeSpec());
    expect(s2).toBe(session);
    f.disposeAll();
  });

  test("idle reaper does not dispose running sessions", () => {
    const f = makeFactory({ reaperIntervalMs: 10, idleTimeoutMs: 0 });
    const session = f.getOrCreate("sid-1", makeSpec());
    forceSessionState(session, "running");
    const s2 = f.getOrCreate("sid-1", makeSpec());
    expect(s2).toBe(session);
    f.disposeAll();
  });

  test("enqueuePrompt throws for unknown sessionId", async () => {
    const f = makeFactory();
    await expect(f.enqueuePrompt("nonexistent", "hi")).rejects.toThrow("Session not found");
  });
});
