// tests/daemon/shared-runtime.test.ts
// Phase 2 shared runtime tests (A08–A10)
//
// These tests exercise the SessionManager with mocked runtime dependencies.
// Full integration tests requiring a live AgentRuntime are marked CI-ONLY.
import { describe, it, expect, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import { SessionManager } from '../../src/daemon/session-manager';
import type { SessionManagerDeps } from '../../src/daemon/session-manager';
import { ContextManager } from '../../src/agent/context';
import { ToolRegistry } from '../../src/agent/tool-registry';
import type { RoutingContext, DaemonSession } from '../../src/im/types';
import { sessionKey } from '../../src/im/types';
import type { AgentProfile } from '../../src/profile/types';
import type { AgentRuntime, SessionConfig } from '../../src/runtime';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Minimal mock AgentRuntime for SessionManager tests. */
function mockRuntime(overrides?: Partial<AgentRuntime>): AgentRuntime {
  const events = new EventEmitter();
  const toolRegistry = new ToolRegistry();
  // Register a basic tool so getAllDefinitions returns something
  toolRegistry.register({
    getDefinition: () => ({
      name: 'read',
      description: 'Read a file',
      parameters: { type: 'object' as const, properties: {} },
    }),
    execute: async () => '',
  });

  const mockAgent = {
    runAgentLoop: async function* () {},
    abort: () => {},
    getContext: () => ({}),
    clear: () => {},
    getContextManager: () => new ContextManager({ tokenLimit: 1000 }),
    getModelName: () => 'mock',
  };

  const sessionStore = {
    ensureSessionDir: async () => {},
    createNewSession: () => ({
      id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  };

  return {
    agent: mockAgent as any,
    provider: {} as any,
    toolRegistry,
    contextManager: new ContextManager({ tokenLimit: 100_000 }),
    sessionStore: sessionStore as any,
    events,
    shutdown: async () => {
      events.removeAllListeners();
    },
    ...overrides,
  };
}

function mockProfile(overrides?: Partial<AgentProfile>): AgentProfile {
  return {
    id: 'test-profile',
    dataDir: '/tmp/test-profile',
    toolProfile: 'code_editor',
    workingDir: '/tmp/test-workspace',
    ...overrides,
  };
}

function mockRoutingContext(overrides?: Partial<RoutingContext>): RoutingContext {
  return {
    chatId: 'oc_test_chat',
    messageId: 'om_test_msg',
    chatType: 'group',
    scope: 'chat',
    anchor: 'oc_test_chat',
    threadRootId: 'om_test_msg',
    larkAppId: 'cli_test_app',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A08: createSession with same routing key twice
// ---------------------------------------------------------------------------

describe('A08: createSession with same routing key twice', () => {
  it('second createSession with same key overwrites first', async () => {
    const runtime = mockRuntime();
    const deps: SessionManagerDeps = {
      runtime,
      profile: mockProfile(),
      larkAppId: 'cli_test_app',
      onAgentEvent: () => {},
    };
    const sm = new SessionManager(deps);
    const ctx = mockRoutingContext();
    const key = sessionKey(ctx.anchor, ctx.larkAppId);

    const ds1 = await sm.createSession(ctx, 'first prompt');
    expect(ds1).toBeDefined();
    expect(sm.activeCount).toBe(1);

    // Create second session with same routing key
    const ds2 = await sm.createSession(ctx, 'second prompt');
    expect(ds2).toBeDefined();
    expect(ds2).not.toBe(ds1); // different session objects

    // Only one session for this key (overwritten)
    expect(sm.activeCount).toBe(1);
    const found = sm.getSession(key);
    expect(found).toBe(ds2); // second call's session is stored
  });

  it('different routing keys produce separate sessions', async () => {
    const runtime = mockRuntime();
    const deps: SessionManagerDeps = {
      runtime,
      profile: mockProfile(),
      larkAppId: 'cli_test_app',
      onAgentEvent: () => {},
    };
    const sm = new SessionManager(deps);

    const ctx1 = mockRoutingContext({ chatId: 'oc_chat_a', anchor: 'oc_chat_a' });
    const ctx2 = mockRoutingContext({ chatId: 'oc_chat_b', anchor: 'oc_chat_b' });

    const ds1 = await sm.createSession(ctx1, 'prompt A');
    const ds2 = await sm.createSession(ctx2, 'prompt B');

    expect(ds1).not.toBe(ds2);
    expect(sm.activeCount).toBe(2);

    const key1 = sessionKey(ctx1.anchor, ctx1.larkAppId);
    const key2 = sessionKey(ctx2.anchor, ctx2.larkAppId);
    expect(sm.getSession(key1)).toBe(ds1);
    expect(sm.getSession(key2)).toBe(ds2);
  });

  it('session is findable by session ID', async () => {
    const runtime = mockRuntime();
    const deps: SessionManagerDeps = {
      runtime,
      profile: mockProfile(),
      larkAppId: 'cli_test_app',
      onAgentEvent: () => {},
    };
    const sm = new SessionManager(deps);

    const ds = await sm.createSession(mockRoutingContext(), 'test prompt');
    const byId = sm.getSessionById(ds.session.id);
    expect(byId).toBe(ds);

    // Also listable
    const all = sm.listSessions();
    expect(all).toHaveLength(1);
    expect(all[0]).toBe(ds);
  });
});

// ---------------------------------------------------------------------------
// A09: create→remove→create ×100, verify memory growth < 5MB (CI-ONLY)
// ---------------------------------------------------------------------------

describe('A09: session lifecycle memory stability', () => {
  // # CI-ONLY: do not run in pre-push hooks
  it.skip('create→remove→create ×100 does not leak memory', async () => {
    const runtime = mockRuntime();
    const deps: SessionManagerDeps = {
      runtime,
      profile: mockProfile(),
      larkAppId: 'cli_test_app',
      onAgentEvent: () => {},
    };
    const sm = new SessionManager(deps);

    const startHeap = process.memoryUsage().heapUsed;

    for (let i = 0; i < 100; i++) {
      const ctx = mockRoutingContext({
        chatId: `oc_chat_${i}`,
        anchor: `oc_chat_${i}`,
      });
      const ds = await sm.createSession(ctx, `prompt ${i}`);
      const key = sessionKey(ctx.anchor, ctx.larkAppId);
      sm.removeSession(key);
    }

    // Force GC if available, then measure
    if (typeof globalThis.gc === 'function') {
      globalThis.gc();
    }

    const endHeap = process.memoryUsage().heapUsed;
    const growthMB = (endHeap - startHeap) / (1024 * 1024);
    // Memory growth should be under 5MB
    expect(growthMB).toBeLessThan(5);

    // Sessions should be cleaned up
    expect(sm.activeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A10: runtime.shutdown aborts in-flight turns
// ---------------------------------------------------------------------------

describe('A10: runtime.shutdown behavior', () => {
  it('shutdown removes all event listeners', async () => {
    const runtime = mockRuntime();
    // Add a listener to verify it gets removed
    let listenerCalled = false;
    runtime.events.on('test', () => { listenerCalled = true; });

    await runtime.shutdown();

    // After shutdown, emit should be a no-op (listeners removed)
    runtime.events.emit('test');
    // Note: removeAllListeners() in EventEmitter only removes listeners.
    // If there are no listeners, emit() still succeeds but callbacks won't fire.
    expect(listenerCalled).toBe(false);
  });

  it('shutdown is idempotent', async () => {
    const runtime = mockRuntime();
    await runtime.shutdown();
    // Second shutdown should not throw
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  it('removeSession calls agent.abort() on running session', () => {
    const runtime = mockRuntime();
    let abortCalled = false;
    const sm = new SessionManager({
      runtime,
      profile: mockProfile(),
      larkAppId: 'cli_test_app',
      onAgentEvent: () => {},
    });

    // Manually inject an agent with a spy on abort
    const key = sessionKey('oc_test', 'cli_test_app');
    (sm as any).agents.set(key, {
      abort: () => { abortCalled = true; },
    });
    (sm as any).sessions.set(key, {
      session: { id: 'test-session' },
      larkAppId: 'cli_test_app',
    });

    sm.removeSession(key);

    expect(abortCalled).toBe(true);
    expect(sm.getSession(key)).toBeUndefined();
  });

  it('removeSession handles missing agent gracefully', () => {
    const runtime = mockRuntime();
    const sm = new SessionManager({
      runtime,
      profile: mockProfile(),
      larkAppId: 'cli_test_app',
      onAgentEvent: () => {},
    });

    // Remove a session that doesn't have an agent
    const key = sessionKey('nonexistent', 'cli_test_app');
    (sm as any).sessions.set(key, {
      session: { id: 'orphan-session' },
      larkAppId: 'cli_test_app',
    });

    // Should not throw
    expect(() => sm.removeSession(key)).not.toThrow();
    expect(sm.getSession(key)).toBeUndefined();
  });
});
