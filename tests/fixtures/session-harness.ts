import { FakeProvider } from './fake-provider';
import { createTempProfile } from './temp-profile';
import { TraceCapture } from './trace-capture';
import { LarkWSMock } from './lark-ws-mock';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { ContextManager } from '../../src/agent/context';
import { ToolRegistry } from '../../src/agent/tool-registry';
import { SessionManager } from '../../src/daemon/session-manager';
import type { SessionManagerDeps } from '../../src/daemon/session-manager';
import { PermissionManager } from '../../src/tools/permission-manager';
import type { AgentRuntime } from '../../src/runtime';
import type { AgentProfile } from '../../src/profile/types';

export interface SessionHarnessOptions {
  provider?: FakeProvider;
  profileId?: string;
  traceBaseDir?: string;
}

/**
 * One-call assembly for integration tests.
 *
 * Wires together a FakeProvider, temp profile, trace capture, Lark WS mock,
 * and a shared EventEmitter so integration tests can be written with minimal
 * boilerplate.
 */
export class SessionHarness {
  provider: FakeProvider;
  profile: ReturnType<typeof createTempProfile>;
  traceCapture: TraceCapture;
  wsMock: LarkWSMock;
  events: EventEmitter;

  constructor(opts: SessionHarnessOptions = {}) {
    this.provider = opts.provider ?? new FakeProvider();
    this.profile = createTempProfile({ profileId: opts.profileId ?? 'harness-test' });
    this.traceCapture = new TraceCapture(
      opts.traceBaseDir ?? join(this.profile.root, 'traces'),
    );
    this.wsMock = new LarkWSMock();
    this.events = new EventEmitter();
  }

  async cleanup(): Promise<void> {
    this.wsMock.close();
    this.events.removeAllListeners();
    this.profile.cleanup();
  }
}

// ── Test Daemon ─────────────────────────────────────────────────────────────

export interface TestDaemon {
  harness: SessionHarness;
  runtime: AgentRuntime;
  sessionManager: SessionManager;
  permissionManager: PermissionManager;
  shutdown: () => Promise<void>;
}

/**
 * Create a minimal mock AgentRuntime suitable for SessionManager construction.
 *
 * This avoids calling the full createAgentRuntime() which requires real
 * providers, file-system settings, MCP, memory, skills, trace, etc.
 * Instead we hand-craft a runtime with just the fields that SessionManager
 * and createSessionAgent need.
 */
function createTestRuntime(harness: SessionHarness): AgentRuntime {
  const events = harness.events;
  const toolRegistry = new ToolRegistry();

  // Register a minimal set of tools so SessionManager.createSession
  // has something to clone into per-session tool registries.
  const readTool = {
    getDefinition: () => ({
      name: 'read',
      description: 'Read a file',
      parameters: { type: 'object' as const, properties: {} },
    }),
    execute: async () => 'fake-read-result',
  };
  toolRegistry.register(readTool);

  const bashTool = {
    getDefinition: () => ({
      name: 'bash',
      description: 'Execute a shell command',
      parameters: { type: 'object' as const, properties: {} },
    }),
    execute: async () => 'fake-bash-result',
  };
  toolRegistry.register(bashTool);

  const grepTool = {
    getDefinition: () => ({
      name: 'grep',
      description: 'Search files',
      parameters: { type: 'object' as const, properties: {} },
    }),
    execute: async () => 'fake-grep-result',
  };
  toolRegistry.register(grepTool);

  // Also register a tool that would be in ALWAYS_EXCLUDE for testing filtering
  const subAgentTool = {
    getDefinition: () => ({
      name: 'sub_agent',
      description: 'Sub-agent tool (should be excluded)',
      parameters: { type: 'object' as const, properties: {} },
    }),
    execute: async () => 'fake-sub-agent-result',
  };
  toolRegistry.register(subAgentTool);

  const contextManager = new ContextManager({
    tokenLimit: 200_000,
    defaultSystemPrompt: '',
  });

  const sessionStore = {
    ensureSessionDir: async () => {},
    createNewSession: () => ({
      id: `test-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  };

  const runtime: AgentRuntime = {
    agent: {
      runAgentLoop: async function* () {},
      abort: () => {},
      getContext: () => ({}),
      clear: () => {},
      getContextManager: () => contextManager,
      getModelName: () => harness.provider.getModelName(),
    } as AgentRuntime['agent'],
    provider: harness.provider,
    toolRegistry,
    contextManager,
    sessionStore: sessionStore as AgentRuntime['sessionStore'],
    events,
    shutdown: async () => {
      events.removeAllListeners();
    },
  };

  return runtime;
}

/**
 * Create a test daemon with SessionManager, PermissionManager, and a
 * minimal mock runtime. Use this for integration tests that exercise
 * session lifecycle without requiring full createAgentRuntime wiring.
 */
export async function startTestDaemon(opts?: {
  profileId?: string;
}): Promise<TestDaemon> {
  const harness = new SessionHarness({ profileId: opts?.profileId });

  const runtime = createTestRuntime(harness);

  const profile: AgentProfile = {
    id: opts?.profileId ?? 'test-profile',
    dataDir: harness.profile.root,
    toolProfile: 'code_editor',
    workingDir: harness.profile.root,
  };

  const sessionManager = new SessionManager({
    runtime,
    profile,
    larkAppId: 'cli_test_app',
    onAgentEvent: (_key, _event) => {
      // no-op event handler for tests
    },
  } satisfies SessionManagerDeps);

  const permissionManager = new PermissionManager();

  const shutdown = async () => {
    for (const ds of sessionManager.listSessions()) {
      const key = `${ds.chatId}\x1f${ds.larkAppId}`;
      sessionManager.removeSession(key);
    }
    await runtime.shutdown();
  };

  return { harness, runtime, sessionManager, permissionManager, shutdown };
}
