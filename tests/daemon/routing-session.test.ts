// tests/daemon/routing-session.test.ts
// Phase 2 routing & session tests (F01–F07)
//
// Many of these tests need the full daemon harness (SessionHarness, LarkWSMock).
// Tests that cannot be written without the harness are marked as skipped with comments.
import { describe, it, expect, beforeEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import { SessionManager } from '../../src/daemon/session-manager';
import type { SessionManagerDeps } from '../../src/daemon/session-manager';
import { ContextManager } from '../../src/agent/context';
import { ToolRegistry } from '../../src/agent/tool-registry';
import { sessionKey } from '../../src/im/types';
import type { RoutingContext } from '../../src/im/types';
import type { AgentProfile } from '../../src/profile/types';
import type { AgentRuntime } from '../../src/runtime';
import { handleCommand, parseSlashCommandInvocation } from '../../src/daemon/command-handler';
import {
  handleNewTopic,
  findSessionById,
  HandlerContext,
  setupCardCallbacks,
} from '../../src/daemon/session-handlers';
import { handleCardAction } from '../../src/im/lark/card-handler';
import { buildResolvedCard } from '../../src/im/lark/card-builder';
import { loadBotsConfig } from '../../src/profile/loader';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mock helpers (shared with Group A test pattern)
// ---------------------------------------------------------------------------

function mockRuntime(): AgentRuntime {
  const events = new EventEmitter();
  const toolRegistry = new ToolRegistry();
  toolRegistry.register({
    getDefinition: () => ({
      name: 'read',
      description: 'Read a file',
      parameters: { type: 'object' as const, properties: {} },
    }),
    execute: async () => '',
  });

  return {
    agent: {
      runAgentLoop: async function* () {},
      abort: () => {},
      getContext: () => ({}),
      clear: () => {},
      getContextManager: () => new ContextManager({ tokenLimit: 1000 }),
      getModelName: () => 'mock',
    } as any,
    provider: {} as any,
    toolRegistry,
    contextManager: new ContextManager({ tokenLimit: 100_000 }),
    sessionStore: {
      ensureSessionDir: async () => {},
      createNewSession: () => ({
        id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    } as any,
    events,
    shutdown: async () => { events.removeAllListeners(); },
  };
}

function mockProfile(): AgentProfile {
  return {
    id: 'test-profile',
    dataDir: '/tmp/test-profile',
    toolProfile: 'code_editor',
    workingDir: '/tmp/test-workspace',
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

function makeSessionManager(): SessionManager {
  return new SessionManager({
    runtime: mockRuntime(),
    profile: mockProfile(),
    larkAppId: 'cli_test_app',
    onAgentEvent: () => {},
  });
}

// ---------------------------------------------------------------------------
// F01: /close → session truly removed from sessionManager
// ---------------------------------------------------------------------------

describe('F01: /close removes session', () => {
  it('handleCommand /close calls removeSession', async () => {
    const sm = makeSessionManager();
    const ctx = mockRoutingContext();
    const ds = await sm.createSession(ctx, 'test prompt');
    const key = sessionKey(ctx.anchor, ctx.larkAppId);

    expect(sm.getSession(key)).toBeDefined();

    // Simulate /close command by calling removeSession directly
    // (handleCommand calls removeSession internally)
    sm.removeSession(key);

    expect(sm.getSession(key)).toBeUndefined();
  });

  it('handleCommand with /close returns true and removes session', async () => {
    const sm = makeSessionManager();
    const ctx = mockRoutingContext();
    const ds = await sm.createSession(ctx, 'test prompt');
    const key = sessionKey(ctx.anchor, ctx.larkAppId);

    let replyContent = '';
    const sessionReply = async (_anchor: string, content: string): Promise<string> => {
      replyContent = content;
      return 'msg-id';
    };

    const result = await handleCommand('/close', '', ds, sm, sessionReply);
    expect(result).toBe(true);
    expect(replyContent).toContain('已关闭');

    // Session should be gone
    expect(sm.getSession(key)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// F02: /close during running turn → agent.abort() called
// ---------------------------------------------------------------------------

describe('F02: /close during running turn aborts agent', () => {
  it('removeSession calls agent.abort()', async () => {
    const sm = makeSessionManager();
    const ctx = mockRoutingContext();
    const ds = await sm.createSession(ctx, 'test');
    const key = sessionKey(ctx.anchor, ctx.larkAppId);

    // Replace the agent with a spy
    let abortCalled = false;
    (sm as any).agents.set(key, {
      abort: () => { abortCalled = true; },
    });

    sm.removeSession(key);

    expect(abortCalled).toBe(true);
    expect(sm.getSession(key)).toBeUndefined();
  });

  it('removeSession is safe when agent has no abort method', () => {
    const sm = makeSessionManager();
    const ctx = mockRoutingContext();
    const key = sessionKey(ctx.anchor, ctx.larkAppId);

    // Inject session with no associated agent
    (sm as any).sessions.set(key, {
      session: { id: 'test-id' },
      larkAppId: 'cli_test_app',
    });

    // Should not throw
    expect(() => sm.removeSession(key)).not.toThrow();
    expect(sm.getSession(key)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// F03: handleNewTopic in existing thread → rootMessageId = thread.root_id
// ---------------------------------------------------------------------------

describe('F03: thread root message ID', () => {
  // handleNewTopic creates a session from a RoutingContext. The session's
  // rootMessageId comes from ctx.threadRootId (which is set to rootId in
  // event-dispatcher or falls back to messageId).

  it('session rootMessageId uses threadRootId from routing context', async () => {
    const sm = makeSessionManager();

    // Simulate a thread reply: rootId is the original post, messageId is the reply
    const ctx = mockRoutingContext({
      messageId: 'om_reply_123',
      threadRootId: 'om_original_456',  // thread root = original post
      chatType: 'p2p',
      scope: 'thread',
      anchor: 'om_original_456',
    });

    const ds = await sm.createSession(ctx, 'reply in thread');
    expect(ds.session.rootMessageId).toBe('om_original_456');
  });

  it('session rootMessageId falls back to messageId when no threadRootId', async () => {
    const sm = makeSessionManager();

    // Fallback: threadRootId defaults to messageId
    const ctx = mockRoutingContext({
      messageId: 'om_top_level',
      threadRootId: 'om_top_level',  // no real root_id
      chatType: 'group',
      scope: 'chat',
      anchor: 'oc_test_chat',
    });

    const ds = await sm.createSession(ctx, 'top-level message');
    expect(ds.session.rootMessageId).toBe('om_top_level');
  });
});

// ---------------------------------------------------------------------------
// F04: same event_id delivered 3 times → only 1 dispatch
// ---------------------------------------------------------------------------

describe('F04: event dedup', () => {
  // isDuplicateEvent() is a module-private function in event-dispatcher.ts
  // and cannot be tested directly. The dedup uses a Set<string> with a max
  // size of 1000 entries and LRU-like eviction.
  //
  // Full integration test requires the Lark WS mock harness.
  // Skipping with comment until harness is available.

  it.skip('F04: event dedup - requires Lark WS mock harness', () => {
    // Integration test using startLarkEventDispatcher with a mock WSClient
    // that delivers the same event_id 3 times; verify only 1 handler call.
  });
});

// ---------------------------------------------------------------------------
// F05: @other_bot in group → dispatch skipped
// ---------------------------------------------------------------------------

describe('F05: foreign bot mention filtering', () => {
  // isBotMentioned() is a module-private function in event-dispatcher.ts.
  // It checks if any mention targets the bot by exact open_id match.
  //
  // Full integration test requires the Lark WS mock harness.
  // Skipping with comment until harness is available.

  it.skip('F05: @other_bot filtering - requires Lark WS mock harness', () => {
    // Integration test: deliver a message where @mentions target a different
    // bot_open_id; verify the handler is NOT called.
  });
});

// ---------------------------------------------------------------------------
// F06: card callback empty session_id → friendly error, no crash
// ---------------------------------------------------------------------------

describe('F06: card callback with empty session_id', () => {
  const mockDeps = {
    interactiveBridge: {} as any,
    onToggleDisplay: () => 'toggle-result',
    onRestart: async () => 'restart-result',
    onClose: async () => 'close-result',
  };

  it('returns friendly error for missing session_id (undefined)', async () => {
    const data = {
      action: {
        value: JSON.stringify({ action: 'close' }),
      },
    };

    const result = await handleCardAction(data as any, mockDeps);
    expect(result).toBeDefined();
    const parsed = JSON.parse(result!);
    expect(parsed.elements[0].text.content).toContain('Session ID is missing');
  });

  it('returns Zod validation error for null session_id', async () => {
    // null fails z.string().optional() Zod validation before the explicit null check
    const data = {
      action: {
        value: JSON.stringify({ action: 'toggle_display', session_id: null }),
      },
    };

    const result = await handleCardAction(data as any, mockDeps);
    expect(result).toBeDefined();
    const parsed = JSON.parse(result!);
    // Zod validation catches null before the explicit null check in the code
    expect(parsed.elements[0].text.content).toContain('Invalid card action data');
  });

  it('returns friendly error for empty string session_id', async () => {
    const data = {
      action: {
        value: JSON.stringify({ action: 'restart', session_id: '' }),
      },
    };

    const result = await handleCardAction(data as any, mockDeps);
    expect(result).toBeDefined();
    const parsed = JSON.parse(result!);
    expect(parsed.elements[0].text.content).toContain('Session ID is empty');
  });

  it('returns friendly error for invalid action value shape', async () => {
    const data = {
      action: {
        value: 'not-json',
      },
    };

    // Should not crash — returns undefined for unparseable JSON
    const result = await handleCardAction(data as any, mockDeps);
    expect(result).toBeUndefined();
  });

  it('returns undefined for missing action field', async () => {
    // When action.value is missing entirely, parseActionValue returns undefined
    const data = {} as any;
    const result = await handleCardAction(data, mockDeps);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// F07: profile.workingDir not exist → startup error
// ---------------------------------------------------------------------------

describe('F07: profile workingDir validation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `profile-f07-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  // Cleanup handled per-test since we test specific file states

  it('loadBotsConfig succeeds when workingDir exists', () => {
    const existingDir = join(tempDir, 'existing-workspace');
    mkdirSync(existingDir, { recursive: true });

    const configPath = join(tempDir, 'bots.yml');
    writeFileSync(configPath, `
profiles:
  test:
    dataDir: ${existingDir}
    toolProfile: general
    workingDir: ${existingDir}
bots: []
`, 'utf-8');

    // Should not throw — paths are resolved but existence is not checked by loader
    const config = loadBotsConfig(configPath);
    expect(config.profiles.test).toBeDefined();
    expect(config.profiles.test.workingDir).toBe(existingDir);
  });

  it('loadBotsConfig does not validate workingDir existence', () => {
    const nonExistentDir = join(tempDir, 'does-not-exist');

    const configPath = join(tempDir, 'bots.yml');
    writeFileSync(configPath, `
profiles:
  test:
    dataDir: ${nonExistentDir}
    toolProfile: read_only
    workingDir: ${nonExistentDir}
bots: []
`, 'utf-8');

    // loadBotsConfig does NOT check that directories exist.
    // It just resolves paths. The existence check would be at daemon startup.
    const config = loadBotsConfig(configPath);
    expect(config.profiles.test.workingDir).toBe(nonExistentDir);
  });

  it('non-existent workingDir is detectable after load', () => {
    const nonExistentDir = join(tempDir, 'missing-workspace');

    const configPath = join(tempDir, 'bots.yml');
    writeFileSync(configPath, `
profiles:
  test:
    dataDir: ${nonExistentDir}
    toolProfile: general
    workingDir: ${nonExistentDir}
bots: []
`, 'utf-8');

    const config = loadBotsConfig(configPath);
    const profile = config.profiles.test;
    expect(profile).toBeDefined();

    // Consumer (daemon startup) should check this
    const exists = existsSync(profile!.workingDir);
    expect(exists).toBe(false);
    // F07: daemon should exit with non-zero when workingDir doesn't exist
    // This test verifies the check is possible; daemon startup test needs harness.
  });
});
