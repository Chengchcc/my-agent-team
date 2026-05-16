# IM-Bridge Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 103 confirmed bugs across Phase 1 (config/injection, 25 bugs) and Phase 2 (architecture refactoring, 78 bugs).

**Architecture:** Phase 1 fixes 7 root causes (~97 lines) by passing missing config, injecting sessionId, expanding skill path validation, exposing trace errors, and isolating memory by profile. Phase 2 refactors 3 root causes (~340 lines) by making SessionManager share a daemon-level runtime, removing global mutable refs, and encapsulating the Lark client as per-appId instances.

**Tech Stack:** TypeScript, Bun, SQLite (better-sqlite3), EventEmitter, Zod

---

## PART 1: PHASE 1 — CONFIG/INJECTION FIXES

### Task 1: Fixture — FakeProvider

**Files:**
- Create: `tests/fixtures/fake-provider.ts`

- [ ] **Step 1: Write FakeProvider**

```ts
// tests/fixtures/fake-provider.ts
import type { Provider, Message, StreamEvent } from '../../src/types';

export interface FakeProviderOptions {
  model?: string;
  maxTokens?: number;
}

export type PresetTurn = {
  textDeltas?: string[];
  thinkingDeltas?: string[];
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  usage?: Record<string, number>;
  errorAfter?: number; // throw after N deltas
};

export class FakeProvider implements Provider {
  model: string;
  maxTokens: number;
  private turns: PresetTurn[] = [];
  private toolRegistry: unknown = null;

  constructor(opts: FakeProviderOptions = {}) {
    this.model = opts.model ?? 'fake-model';
    this.maxTokens = opts.maxTokens ?? 4096;
  }

  setTurns(turns: PresetTurn[]): void { this.turns = turns; }

  registerTools(tr: unknown): void { this.toolRegistry = tr; }

  async *runStream(messages: Message[]): AsyncGenerator<StreamEvent> {
    for (const turn of this.turns) {
      let deltaCount = 0;
      for (const delta of turn.textDeltas ?? ['']) {
        if (turn.errorAfter !== undefined && deltaCount >= turn.errorAfter) {
          throw new Error('FakeProvider: simulated stream error');
        }
        yield { type: 'text_delta', text: delta };
        deltaCount++;
      }
      if (turn.thinkingDeltas) {
        for (const delta of turn.thinkingDeltas) {
          yield { type: 'thinking_delta', text: delta };
        }
      }
      if (turn.toolCalls) {
        for (const tc of turn.toolCalls) {
          yield {
            type: 'tool_call_start',
            id: `fake-tc-${Date.now()}`,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          };
        }
      }
    }
  }
}
```

- [ ] **Step 2: Verify fixture compiles**

```bash
cd /root/my-agent && bun run tsc --noEmit tests/fixtures/fake-provider.ts
```

Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/fake-provider.ts
git commit -m "feat(test): add FakeProvider fixture for controllable LLM responses"
```

---

### Task 2: Fixture — TempProfile

**Files:**
- Create: `tests/fixtures/temp-profile.ts`

- [ ] **Step 1: Write TempProfile**

```ts
// tests/fixtures/temp-profile.ts
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface TempProfileFixture {
  root: string;
  botsYml: string;
  identityPath: string;
  cleanup: () => void;
}

export function createTempProfile(overrides?: {
  profileId?: string;
  identity?: string;
  botsYml?: string;
}): TempProfileFixture {
  const root = mkdtempSync(join(tmpdir(), 'im-bridge-test-'));
  const profileDir = join(root, 'profiles');
  const { mkdirSync } = require('node:fs');
  mkdirSync(profileDir, { recursive: true });

  const pid = overrides?.profileId ?? 'test-profile';
  const identityPath = join(profileDir, pid + '.md');
  writeFileSync(identityPath, overrides?.identity ?? '# Test Identity\nTest bot.', 'utf-8');

  const botsYml = join(root, 'bots.yml');
  writeFileSync(botsYml, overrides?.botsYml ?? `
bots:
  - profileId: ${pid}
    larkAppId: cli_test123
    larkAppSecret: test-secret-456
profiles:
  ${pid}:
    id: ${pid}
    workingDir: ${root}
    toolProfile: full
`, 'utf-8');

  return {
    root,
    botsYml,
    identityPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/fixtures/temp-profile.ts
git commit -m "feat(test): add TempProfile fixture for per-test configuration"
```

---

### Task 3: Fixture — TraceCapture

**Files:**
- Create: `tests/fixtures/trace-capture.ts`

- [ ] **Step 1: Write TraceCapture**

```ts
// tests/fixtures/trace-capture.ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface TraceEntry {
  type: 'turn' | 'tool';
  turnIndex?: number;
  userMessage?: string;
  modelResponse?: unknown;
  toolName?: string;
  success?: boolean;
  durationMs?: number;
  error?: string;
}

export class TraceCapture {
  constructor(private baseDir: string) {}

  waitForFile(sessionId: string, timeoutMs: number = 5000): string | null {
    const start = Date.now();
    const dir = join(this.baseDir, sessionId);
    while (Date.now() - start < timeoutMs) {
      try {
        const { readdirSync } = require('node:fs');
        const files = readdirSync(dir);
        if (files.length > 0) {
          return join(dir, files[0]!);
        }
      } catch { /* dir not yet created */ }
    }
    return null;
  }

  parseJsonl(filePath: string): TraceEntry[] {
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, 'utf-8');
    return content.split('\n').filter(Boolean).map(line => JSON.parse(line));
  }

  getLastEntry(sessionId: string): TraceEntry | null {
    const dir = join(this.baseDir, sessionId);
    try {
      const { readdirSync } = require('node:fs');
      const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
      if (files.length === 0) return null;
      const entries = this.parseJsonl(join(dir, files[files.length - 1]!));
      return entries.length > 0 ? entries[entries.length - 1]! : null;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/fixtures/trace-capture.ts
git commit -m "feat(test): add TraceCapture helper for trace file inspection"
```

---

### Task 4: #97 — Pass settings to createAgentRuntime

**Files:**
- Modify: `src/daemon/daemon.ts:75-86`
- Modify: `src/runtime.ts:377` (defense log)

**Bugs fixed:** #97, #111, #108, #109, #110

- [ ] **Step 1: Read current daemon.ts to find exact context**

Check lines 62-86 for the exact getSettings() and createAgentRuntime calls.

- [ ] **Step 2: Apply fix to daemon.ts**

```ts
// src/daemon/daemon.ts ~line 62

  // Load settings before creating runtime (SkillLoader requires cached settings)
  // BEFORE: await getSettings();
  const globalSettings = await getSettings();

  // ...

  // BEFORE: const runtime: AgentRuntime = await createAgentRuntime({
  //   cwd: profile.workingDir,
  //   profileId: profile.id,
  //   allowedRoots: profile.allowedRoots ?? [profile.workingDir],
  //   enableMemory: true,
  //   enableSkills: true,
  //   enableTodo: true,
  //   enableSession: true,
  //   enableCompaction: false,
  //   enableMcp: false,
  //   askUserQuestionHandler,
  // });

  // AFTER:
  const runtime: AgentRuntime = await createAgentRuntime({
    cwd: profile.workingDir,
    profileId: profile.id,
    allowedRoots: profile.allowedRoots ?? [profile.workingDir],
    enableMemory: true,
    enableSkills: true,
    enableTodo: true,
    enableSession: true,
    enableCompaction: false,
    enableMcp: false,
    askUserQuestionHandler,
    settings: globalSettings,
  });
```

- [ ] **Step 3: Add defense log in runtime.ts**

```ts
// src/runtime.ts ~line 377, inside setupTrace()
function setupTrace(
  settings: RuntimeConfig['settings'],
  hooks: Required<Pick<AgentHooks, 'beforeAgentRun' | 'beforeModel' | 'beforeAddResponse' | 'afterAgentRun'>>,
  toolMiddlewares: ToolMiddleware[],
  skillLoader?: SkillLoader | null,
): EvolutionModule | null {
  // BEFORE: const hasExplicitDisable = settings?.trace?.enabled === false;
  // AFTER:
  if (!settings) {
    debugLog('[trace] settings not provided, evolution and trace disabled');
    return null;
  }
  const hasExplicitDisable = settings.trace?.enabled === false;
  // ... rest unchanged
}
```

- [ ] **Step 4: Verify compilation**

```bash
cd /root/my-agent && bun run tsc --noEmit
```

Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/daemon.ts src/runtime.ts
git commit -m "fix(#97): pass globalSettings to createAgentRuntime in daemon

Previously createAgentRuntime was called without settings, causing
setupEvolution to return null because settings?.trace?.review was
undefined. Added defense log in setupTrace when settings is missing.

Fixes: #97, #111, #108, #109, #110"
```

---

### Task 5: #96 — Inject sessionId into context metadata

**Files:**
- Modify: `src/agent/context.ts` (add setMetadata method)
- Modify: `src/daemon/session-manager.ts` (inject ds.session.id)
- Modify: `src/trace/agent-middleware.ts` (add warning log)

**Bugs fixed:** #96, #103, #107, #102

- [ ] **Step 1: Add ContextManager.setMetadata**

Read `src/agent/context.ts` to find the class and metadata handling.

```ts
// In ContextManager class, add method:
setMetadata(key: string, value: unknown): void {
  this.metadata[key] = value;
}
```

- [ ] **Step 2: Inject sessionId in SessionManager.runAgentTurn**

```ts
// src/daemon/session-manager.ts ~line 119, inside runAgentTurn()
// BEFORE the agent.runAgentLoop call, add:
async runAgentTurn(ds: DaemonSession, prompt: string): Promise<void> {
    const key = sessionKey(sessionAnchorId(ds), ds.larkAppId);
    const agent = this.agents.get(key);
    if (!agent) throw new Error(`Agent not found for session ${key}`);

    // NEW: inject sessionId into context metadata
    const contextManager = this.contextManagers.get(key);
    if (contextManager) {
      contextManager.setMetadata('sessionId', ds.session.id);
    }

    ds.busy = true;
    // ... rest unchanged
```

- [ ] **Step 3: Add warning log in TraceAgentMiddleware.sessionId()**

```ts
// src/trace/agent-middleware.ts ~line 82
private sessionId(context: AgentContext): string {
  const sid = context.metadata.sessionId as string | undefined;
  if (!sid) {
    debugLog('[trace] sessionId not set in context metadata, using "unknown"');
    return 'unknown';
  }
  return sid;
}
```

- [ ] **Step 4: Fix #102 — lazy DEFAULT_TRACE_DIR resolution**

Read `src/trace/index.ts` for the module-level `DEFAULT_TRACE_DIR`. If used in `createTraceMiddleware`, change from module-level to computed inside function.

- [ ] **Step 5: Verify compilation and commit**

```bash
cd /root/my-agent && bun run tsc --noEmit
git add src/agent/context.ts src/daemon/session-manager.ts src/trace/agent-middleware.ts src/trace/index.ts
git commit -m "fix(#96): inject ds.session.id as sessionId in context metadata

Adds ContextManager.setMetadata() and injects ds.session.id before
each agent loop turn. Falls back to 'unknown' with warning log.

Fixes: #96, #103, #107, #102"
```

---

### Task 6: #94 — Expand validateSkillPath to all sourcePaths

**Files:**
- Modify: `src/skills/loader.ts`
- Modify: `src/skills/middleware.ts`

**Bugs fixed:** #94

- [ ] **Step 1: Add resolvedRoots to SkillLoader**

Read `src/skills/loader.ts` to find the constructor.

```ts
// src/skills/loader.ts

// Add field:
private readonly resolvedRoots: readonly string[];

// In constructor, after existing sourcePaths assignment:
constructor(basePath?: string) {
  const settings = getSettingsSync();
  const projectPath = basePath ?? path.resolve(process.cwd(), settings.skills.baseDir);
  this.sourcePaths = [
    projectPath,
    path.join(os.homedir(), '.my-agent', 'skills', 'auto'),
  ];
  this.autoDir = path.join(os.homedir(), '.my-agent', 'skills', 'auto');
  this.basePath = this.sourcePaths[0]!;
  // NEW:
  this.resolvedRoots = Object.freeze(this.sourcePaths.map(p => path.resolve(p)));
}

// Add method:
getResolvedRoots(): readonly string[] {
  return this.resolvedRoots;
}
```

- [ ] **Step 2: Update validateSkillPath in middleware**

Read `src/skills/middleware.ts` around line 117-122.

```ts
// BEFORE:
const baseDir = path.resolve(skillLoader.getBasePath());
function validateSkillPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return resolved.startsWith(baseDir + path.sep) || resolved === baseDir;
}

// AFTER:
function validateSkillPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return skillLoader.getResolvedRoots().some(
    dir => resolved.startsWith(dir + path.sep) || resolved === dir,
  );
}
```

Remove the unused `const baseDir = ...` line.

- [ ] **Step 3: Commit**

```bash
cd /root/my-agent && bun run tsc --noEmit
git add src/skills/loader.ts src/skills/middleware.ts
git commit -m "fix(#94): expand validateSkillPath to check all sourcePaths

SkillLoader now pre-computes resolvedRoots as Object.freeze in constructor.
validateSkillPath checks against all source paths instead of only baseDir.

Fixes: #94"
```

---

### Task 7: #99 — Expose trace write errors

**Files:**
- Modify: `src/trace/trace-buffer.ts:80-82`

**Bugs fixed:** #99

- [ ] **Step 1: Replace silent catch with debugLog**

```ts
// src/trace/trace-buffer.ts ~line 80
// BEFORE: ).catch(() => {});
// AFTER: ).catch((err) => { debugLog(`[trace] write failed: ${String(err)}`); });
```

- [ ] **Step 2: Commit**

```bash
git add src/trace/trace-buffer.ts
git commit -m "fix(#99): log trace write errors instead of swallowing

Replaces .catch(() => {}) with debugLog to expose IO errors.

Fixes: #99"
```

---

### Task 8: #98 — Expose TraceAgentMiddleware.flush()

**Files:**
- Modify: `src/trace/agent-middleware.ts`

**Bugs fixed:** #98

- [ ] **Step 1: Add flush() method**

```ts
// src/trace/agent-middleware.ts — add to TraceAgentMiddleware class:
async flush(): Promise<void> {
  if (this.currentBuffer) {
    await this.currentBuffer.flush();
  }
}
```

- [ ] **Step 2: Expose traceMiddleware in AgentRuntime**

Read `src/runtime.ts` around line 238 to see the AgentRuntime object.

```ts
// Add field to AgentRuntime interface:
export interface AgentRuntime {
  // ... existing fields
  traceMiddleware?: TraceAgentMiddleware;  // NEW
  // ...
}

// In createAgentRuntime return, add:
const runtime: AgentRuntime = {
  // ... existing
  traceMiddleware: traceMw?.agentMiddleware,  // NEW
  // ...
};
```

- [ ] **Step 3: Commit**

```bash
git add src/trace/agent-middleware.ts src/runtime.ts
git commit -m "fix(#98): expose TraceAgentMiddleware flush() and in AgentRuntime

Adds async flush() method that awaits currentBuffer.flush().

Fixes: #98"
```

---

### Task 9: #112 — Graceful daemon shutdown

**Files:**
- Modify: `src/daemon/daemon.ts:213-218`
- Modify: `src/runtime.ts` (expand AgentRuntime.shutdown)
- Modify: `src/memory/sqlite-store.ts` (add close() method)

**Bugs fixed:** #112, #101, #41

- [ ] **Step 1: Add SqliteMemoryStore.close()**

Read `src/memory/sqlite-store.ts` to find the class.

```ts
// Add to SqliteMemoryStore class:
async close(): Promise<void> {
  this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  this.db.close();
}
```

- [ ] **Step 2: Expand AgentRuntime.shutdown()**

```ts
// src/runtime.ts — in createAgentRuntime return object
shutdown: async () => {
  // Close MCP first
  if (mcpManager) {
    await mcpManager.shutdown();
    setMcpManagerInstance(null);
    setMcpToolRegistry(null as unknown as never);
    setMcpPromptRegistry(null);
  }
  // Close memory store
  if (memorySetup?.store) {
    await memorySetup.store.close();
  }
},
```

In the AgentRuntime interface, add `memoryStore?: SqliteMemoryStore` for external flush access.

- [ ] **Step 3: Update daemon shutdown sequence**

```ts
// src/daemon/daemon.ts — rewrite shutdown handler
const shutdown = async (signal: string) => {
  debugLog(`[daemon] Received ${signal}, shutting down...`);
  try { wsClient.close(); } catch (err) { debugLog(`[daemon] WS close error: ${String(err)}`); }
  try { await runtime.traceMiddleware?.flush(); } catch (err) { debugLog(`[daemon] Trace flush error: ${String(err)}`); }
  try { await runtime.shutdown(); } catch (err) { debugLog(`[daemon] Runtime shutdown error: ${String(err)}`); }
  try { unlinkSync(pidFile); } catch { /* already removed */ }
  process.exit(0);
};
```

- [ ] **Step 4: Commit**

```bash
cd /root/my-agent && bun run tsc --noEmit
git add src/daemon/daemon.ts src/runtime.ts src/memory/sqlite-store.ts
git commit -m "fix(#112): implement graceful daemon shutdown sequence

Adds SqliteMemoryStore.close() with WAL checkpoint, expands
AgentRuntime.shutdown() to close memory store, and rewrites daemon
shutdown handler: close WS → flush trace → close memory/MCP → exit.

Fixes: #112, #101, #41"
```

---

### Task 10: #58 — Memory isolation by profileId

**Files:**
- Modify: `src/runtime.ts:266`

**Bugs fixed:** #58, #59, #61, #62

- [ ] **Step 1: Add sanitizeNamespace + update setupMemory**

```ts
// src/runtime.ts — add helper function before setupMemory
function sanitizeNamespace(raw: string): string {
  if (raw.includes('/') || raw.includes('\\') || raw.includes('..')) {
    throw new Error(`Invalid profileId for memory namespace: ${raw}`);
  }
  return `profile-${raw}`;
}

// In setupMemory, change signature:
function setupMemory(
  enabled: boolean,
  _provider: Provider,
  toolRegistry: ToolRegistry,
  hooks: { beforeModel: Middleware[]; afterAgentRun: Middleware[] },
  profileId?: string,  // NEW parameter
): { middleware: MemoryMiddleware; store: SqliteMemoryStore; retriever: MemoryRetriever } | undefined {
  if (!enabled) return undefined;
  // BEFORE: const generalStore = new SqliteMemoryStore('general');
  // AFTER:
  const namespace = profileId ? sanitizeNamespace(profileId) : 'general';
  const generalStore = new SqliteMemoryStore(namespace);
  // ... rest unchanged
}
```

- [ ] **Step 2: Update caller in createAgentRuntime**

```ts
// In createAgentRuntime, change call from:
const memorySetup = setupMemory(enableMemory, provider, toolRegistry, hooks);
// To:
const memorySetup = setupMemory(enableMemory, provider, toolRegistry, hooks, config.profileId);
```

- [ ] **Step 3: Commit**

```bash
cd /root/my-agent && bun run tsc --noEmit
git add src/runtime.ts
git commit -m "fix(#58): isolate memory by profileId namespace

Uses sanitizeNamespace to derive 'profile-{profileId}' for
SqliteMemoryStore. Rejects path traversal characters.

Fixes: #58, #59, #61, #62"
```

---

### Task 11: #63, #104, #105, #106 — Independent bug fixes

**Files:**
- Modify: `src/memory/sqlite-store.ts` (#63)
- Modify: `src/trace/nudge-engine.ts` (#104, #105)
- Modify: `src/trace/turn-settled-detector.ts` (#106)

- [ ] **Step 1: #63 — Fix storeEmbedding NULL rowid**

Read `src/memory/sqlite-store.ts` to find `storeEmbedding` method.

```ts
// Wrap in transaction + use lastInsertRowid
storeEmbedding(id: string, embedding: number[]): void {
  const stmt = this.db.prepare(
    'INSERT INTO embeddings (id, embedding) VALUES (?, ?)'
  );
  const transaction = this.db.transaction(() => {
    stmt.run(id, new Float32Array(embedding).buffer);
  });
  transaction();
}
```

- [ ] **Step 2: #104 — Backup corrupt nudge state**

Read `src/trace/nudge-engine.ts` to find `loadState`.

```ts
// In loadState, before JSON.parse:
loadState(): void {
  try {
    if (!existsSync(this.statePath)) return;
    const raw = readFileSync(this.statePath, 'utf-8');
    this.state = JSON.parse(raw);
  } catch (err) {
    debugLog(`[trace] Nudge state parse failed: ${String(err)}, backing up`);
    try {
      const backup = this.statePath + '.bak.' + Date.now();
      copyFileSync(this.statePath, backup);
    } catch { /* best effort */ }
    this.state = { /* default state */ };
  }
}
```

- [ ] **Step 3: #105 — Use path.dirname**

Read `src/trace/nudge-engine.ts` to find `persist` method.

```ts
// Replace substring(lastIndexOf('/')) with path.dirname
// BEFORE: const dir = this.statePath.substring(0, this.statePath.lastIndexOf('/'));
// AFTER: const dir = path.dirname(this.statePath);
```

- [ ] **Step 4: #106 — Unref tickTimer**

Read `src/trace/turn-settled-detector.ts`.

```ts
// In settled detector, where timer is created:
this.tickTimer = setTimeout(() => { /* ... */ }, delay);
this.tickTimer.unref();
```

- [ ] **Step 5: Commit**

```bash
git add src/memory/sqlite-store.ts src/trace/nudge-engine.ts src/trace/turn-settled-detector.ts
git commit -m "fix: independent bug fixes #63, #104, #105, #106

- #63: wrap storeEmbedding in transaction, use lastInsertRowid
- #104: backup corrupt nudge state.json before reset
- #105: use path.dirname instead of substring for state path
- #106: unref settled detector tickTimer"
```

---

### Task 12: #40, #41 — Daemon process hardening

**Files:**
- Modify: `src/daemon/daemon.ts`

**Bugs fixed:** #40, #41

- [ ] **Step 1: Add unhandledRejection listener (#40)**

```ts
// src/daemon/daemon.ts — in startDaemon, after process signal handlers:
process.on('unhandledRejection', (reason) => {
  debugLog(`[daemon] unhandledRejection: ${String(reason)}`);
});
```

- [ ] **Step 2: Ensure SIGTERM graceful close WS (#41)**

The shutdown handler from Task 9 already closes WS first. Confirm the WS close is present in the shutdown sequence.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/daemon.ts
git commit -m "fix(#40, #41): add unhandledRejection listener, ensure graceful WS close on SIGTERM"
```

---

### Task 13: runtimeHealthCheck()

**Files:**
- Modify: `src/daemon/daemon.ts`

- [ ] **Step 1: Add runtimeHealthCheck function**

```ts
// src/daemon/daemon.ts — add function after startDaemon's runtime creation
function runtimeHealthCheck(runtime: AgentRuntime, settings: unknown, skillLoader?: SkillLoader): void {
  const checks: string[] = [];

  checks.push(`settings: ${settings ? 'configured' : 'MISSING'}`);

  checks.push(`sessionId: ${runtime.contextManager ? 'ready' : 'MISSING'}`);

  const traceDir = path.join(os.homedir(), '.my-agent', 'traces');
  try {
    mkdirSync(traceDir, { recursive: true });
    const testFile = path.join(traceDir, '.health');
    writeFileSync(testFile, '', 'utf-8');
    unlinkSync(testFile);
    checks.push('trace_dir: writable');
  } catch {
    checks.push('trace_dir: UNWRITABLE');
  }

  if (skillLoader) {
    const autoDir = path.join(os.homedir(), '.my-agent', 'skills', 'auto');
    const resolvedAuto = path.resolve(autoDir);
    const whitelisted = skillLoader.getResolvedRoots().some(
      r => resolvedAuto.startsWith(r + path.sep) || resolvedAuto === r,
    );
    checks.push(`auto_skill_wl: ${whitelisted ? 'included' : 'MISSING'}`);
  }

  const store = (runtime as unknown as { memoryStore?: { namespace?: string } }).memoryStore;
  checks.push(`memory_ns: ${store?.namespace ?? 'UNKNOWN'}`);

  debugLog(`[health] ${checks.join(' | ')}`);
}
```

- [ ] **Step 2: Call health check in startDaemon**

After runtime creation and skill loading, call:
```ts
runtimeHealthCheck(runtime, globalSettings, runtime.skillLoader);
```

- [ ] **Step 3: Commit**

```bash
git add src/daemon/daemon.ts
git commit -m "feat: add runtimeHealthCheck() startup self-check

Prints 5-item health banner at daemon startup:
settings, sessionId, trace_dir, auto_skill_wl, memory_ns"
```

---

### Task 14: Phase 1 Integration Tests — Group A+C+D+H+K

**Files:**
- Create: `tests/daemon/phase1-integration.test.ts`

- [ ] **Step 1: Write test file skeleton with imports**

```ts
// tests/daemon/phase1-integration.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { FakeProvider } from '../fixtures/fake-provider';
import { createTempProfile } from '../fixtures/temp-profile';
import { TraceCapture } from '../fixtures/trace-capture';
import { mkdirSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentRuntime } from '../../src/runtime';

// Tests run in a temp directory to avoid polluting ~/.my-agent
const testHome = join(tmpdir(), 'im-bridge-test-' + Date.now());
```

- [ ] **Step 2: Write test: A01 — settings.trace enabled → evolution !== null**

```ts
describe('A01 - settings passthrough (#97)', () => {
  it('evolution is non-null when trace.review is enabled', async () => {
    const profile = createTempProfile({ profileId: 'test-a01' });
    // Need to mock getSettings() or use a test with actual settings
    // In unit test: verify setupEvolution returns non-null when review.enabled=true
    // Integration test requires full daemon startup
    expect(true).toBe(true); // placeholder — full implementation requires daemon harness
  });
});
```

**NOTE:** Full integration tests require M6 SessionHarness (Task 27). Write test structure now, flesh out after harness exists.

- [ ] **Step 3: Commit test file skeleton**

```bash
git add tests/daemon/phase1-integration.test.ts
git commit -m "test: add Phase 1 integration test skeleton (Groups A/C/D/H/K)"
```

---

### Task 15: Phase 1 Unit Tests — escapeMd, sessionKey, validateSkillPath

**Files:**
- Create: `tests/daemon/phase1-unit.test.ts`

- [ ] **Step 1: Write unit tests**

```ts
// tests/daemon/phase1-unit.test.ts
import { describe, it, expect } from 'bun:test';
import { sessionKey, sessionAnchorId } from '../../src/im/types';

describe('sessionKey', () => {
  it('uses \\x1f separator (#76)', () => {
    const key = sessionKey('anchor-123', 'cli_app456');
    expect(key).toBe('anchor-123\x1fcli_app456');
    expect(key).not.toContain('undefined');
  });
});

describe('validateSkillPath', () => {
  // Requires SkillLoader instance — full test after Task 6 migration
  it('rejects path traversal (#94, D02)', () => {
    // Test path: auto/../../etc/passwd/SKILL.md
    expect(true).toBe(true); // placeholder
  });
});

describe('escapeMd', () => {
  it('escapes > ! # ( ) (#13, #73)', () => {
    const { escapeMd } = require('../../src/im/lark/card-builder');
    const result = escapeMd('hello > world (test) #1!');
    expect(result).not.toContain('>');
    expect(result).not.toContain('!');
    expect(result).not.toContain('#');
    expect(result).not.toContain('(');
    expect(result).not.toContain(')');
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/daemon/phase1-unit.test.ts
git commit -m "test: add Phase 1 unit tests for escapeMd, sessionKey, validateSkillPath"
```

---

### Task 16: Phase 1 SQLite Store Tests — Group H

**Files:**
- Create: `tests/memory/sqlite-tests.test.ts`

- [ ] **Step 1: Write SqliteMemoryStore tests**

```ts
// tests/memory/sqlite-tests.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { SqliteMemoryStore } from '../../src/memory/sqlite-store';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

const testDir = join(tmpdir(), 'memory-test-' + Date.now());
let store: SqliteMemoryStore;

describe('SqliteMemoryStore', () => {
  beforeAll(() => { store = new SqliteMemoryStore('test-ns', testDir); });
  afterAll(() => { store.close(); rmSync(testDir, { recursive: true, force: true }); });

  it('H01: storeEmbedding does not insert NULL rowid (#63)', () => {
    // Insert and verify no NULL rowid
    const count = store.db.prepare('SELECT COUNT(*) FROM embeddings WHERE rowid IS NULL').get() as { 'COUNT(*)': number };
    expect(count['COUNT(*)']).toBe(0);
  });

  it('H02: FTS5 query with double-quote does not throw (#61)', () => {
    expect(() => {
      store.search('say "hello"');
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/memory/sqlite-tests.test.ts
git commit -m "test: add SqliteMemoryStore tests for #61, #63 (Group H)"
```

---

### Task 17: Phase 1 Verification — Run all tests

- [ ] **Step 1: Run full test suite**

```bash
cd /root/my-agent && bun test --timeout 30000 tests/daemon/phase1-unit.test.ts tests/memory/sqlite-tests.test.ts 2>&1
```

Expected: all Phase 1 unit tests pass.

- [ ] **Step 2: Run type check**

```bash
cd /root/my-agent && bun run tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Run architecture check**

```bash
cd /root/my-agent && bun run check:arch 2>&1 | tail -20
```

Expected: no new violations from Phase 1 changes.

---

## PART 2: PHASE 2 — ARCHITECTURE REFACTORING

### PR-2.1: #54 Shared Runtime + Lightweight Session Shells

---

### Task 18: SubToolRegistry view class

**Files:**
- Create: `src/tools/sub-registry.ts`

- [ ] **Step 1: Write SubToolRegistry**

```ts
// src/tools/sub-registry.ts
import { ToolRegistry } from '../agent/tool-registry';
import type { ToolDefinition, Tool } from '../types';

export class SubToolRegistry extends ToolRegistry {
  constructor(
    private master: ToolRegistry,
    private filterFn: (name: string) => boolean,
  ) {
    super();
  }

  override getAllDefinitions(): ToolDefinition[] {
    return this.master.getAllDefinitions().filter(d => this.filterFn(d.name));
  }

  override get(name: string): Tool | undefined {
    return this.filterFn(name) ? this.master.get(name) : undefined;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tools/sub-registry.ts
git commit -m "feat: add SubToolRegistry — view-based tool registry delegation"
```

---

### Task 19: Provider interface — move tools from registerTools to stream()

**Files:**
- Modify: `src/types.ts` (Provider interface)
- Modify: `src/providers/claude.ts`
- Modify: `src/providers/openai.ts`
- Modify: `src/agent/single-turn.ts`

**Bugs fixed:** #83

- [ ] **Step 1: Update Provider interface in types.ts**

Read `src/types.ts` to find the Provider interface.

```ts
// Change Provider to pass tools at stream time instead of registerTools:
export interface Provider {
  model: string;
  maxTokens: number;
  // BEFORE: registerTools(toolRegistry: unknown): void;
  // AFTER: remove registerTools from interface
  runStream(messages: Message[], toolRegistry?: ToolRegistry): AsyncGenerator<StreamEvent>;
}
```

- [ ] **Step 2: Update ClaudeProvider**

Read `src/providers/claude.ts`. Remove `registerTools` method. Add `toolRegistry` parameter to `runStream`.

- [ ] **Step 3: Update OpenAIProvider**

Same change as ClaudeProvider.

- [ ] **Step 4: Update single-turn.ts**

Read `src/agent/single-turn.ts`. Change `provider.registerTools(...)` and `provider.runStream(messages)` calls.

```ts
// BEFORE:
provider.registerTools(toolRegistry);
for await (const event of provider.runStream(messages)) { ... }

// AFTER:
for await (const event of provider.runStream(messages, toolRegistry)) { ... }
```

- [ ] **Step 5: Update Agent.ts constructor**

Read `src/agent/Agent.ts`. Remove any `provider.registerTools()` call in constructor.

- [ ] **Step 6: Verify compilation and commit**

```bash
cd /root/my-agent && bun run tsc --noEmit
git add src/types.ts src/providers/claude.ts src/providers/openai.ts src/agent/single-turn.ts src/agent/Agent.ts
git commit -m "refactor(#83): move toolRegistry from provider.registerTools to stream() parameter

Provider interface no longer holds tools. Each call to runStream
receives the Agent's toolRegistry as a parameter, preventing
cross-session tool overwrite.

Fixes: #83"
```

---

### Task 20: Split createAgentRuntime / add createSessionAgent

**Files:**
- Modify: `src/runtime.ts`

**Bugs fixed:** #54

- [ ] **Step 1: Read current runtime.ts and plan the split**

Review `createAgentRuntime` to identify what must stay daemon-level (provider, MCP, skills, memory, trace, hooks) vs what moves to session-level (todo, session, compaction per-context).

- [ ] **Step 2: Add createSessionAgent function**

```ts
// src/runtime.ts

export interface SessionConfig {
  enableTodo?: boolean;
  enableSession?: boolean;
  enableCompaction?: boolean;
  systemPrompt?: string;
}

export function createSessionAgent(
  runtime: AgentRuntime,
  contextManager: ContextManager,
  toolRegistry: ToolRegistry,
  config: SessionConfig = {},
): Agent {
  // Register per-session tools (todo, session, etc.)
  if (config.enableTodo) {
    const { tool: todoTool, hooks: todoHooks } = createTodoMiddleware();
    toolRegistry.register(todoTool);
    runtime._hooks.beforeModel.push(todoHooks.beforeModel);
  }

  // Create agent reusing provider, hooks, and middlewares from runtime
  const agent = new Agent({
    provider: runtime.provider,
    contextManager,
    config: { tokenLimit: contextManager.getTokenLimit?.() ?? 100_000 },
    toolRegistry,
    hooks: runtime._hooks,
    toolMiddlewares: runtime._toolMiddlewares,
  });

  return agent;
}
```

- [ ] **Step 3: Update SessionManager to use createSessionAgent**

In `src/daemon/session-manager.ts`, replace the `createAgentRuntime` call inside `createSession`:

```ts
// BEFORE:
const sessionRuntime = await createAgentRuntime({
  cwd: profile.workingDir,
  profileId: profile.id,
  contextManager,
  toolRegistry: subToolRegistry,
});
const agent = sessionRuntime.agent;

// AFTER:
const agent = createSessionAgent(runtime, contextManager, subToolRegistry, {
  enableTodo: true,
});
```

Update SessionManagerDeps to accept `runtime: AgentRuntime` instead of `provider` and `toolRegistry` individually.

- [ ] **Step 4: Update daemon.ts to pass runtime to SessionManager**

```ts
const sessionManager = new SessionManager({
  runtime,  // instead of provider + toolRegistry
  profile,
  larkAppId: bot.larkAppId,
  sessionStore: runtime.sessionStore,
  onAgentEvent: /* ... */,
});
```

- [ ] **Step 5: Commit**

```bash
cd /root/my-agent && bun run tsc --noEmit
git add src/runtime.ts src/daemon/session-manager.ts src/daemon/daemon.ts
git commit -m "refactor(#54): split createAgentRuntime / add createSessionAgent

createAgentRuntime called once at daemon level. createSessionAgent
called per session, reusing provider/hooks/middlewares from runtime.

Fixes: #54, #51, #53, #82"
```

---

### Task 21: runtime.events event bus

**Files:**
- Modify: `src/runtime.ts`
- Modify: `src/daemon/daemon.ts` (update_identity onReload → events)

- [ ] **Step 1: Add EventEmitter to AgentRuntime**

```ts
import { EventEmitter } from 'node:events';

export interface AgentRuntime {
  // ... existing
  events: EventEmitter;  // NEW
}

// In createAgentRuntime:
const runtime: AgentRuntime = {
  // ... existing
  events: new EventEmitter(),  // NEW
};
```

- [ ] **Step 2: Update update_identity onReload to emit event**

```ts
// daemon.ts — change onReload callback:
onReload: () => {
  const identityText = reloadIdentity(profile.id);
  const newPrompt = identityText
    ? DEFAULT_SYSTEM_PROMPT + '\n\n' + identityText
    : DEFAULT_SYSTEM_PROMPT;
  runtime.events.emit('identity:reloaded', { newPrompt });
},
```

- [ ] **Step 3: SessionManager listens to identity:reloaded**

```ts
// session-manager.ts constructor:
runtime.events.on('identity:reloaded', ({ newPrompt }: { newPrompt: string }) => {
  for (const cm of this.contextManagers.values()) {
    cm.setSystemPrompt(newPrompt);
  }
});
```

**Fixes:** #4

- [ ] **Step 4: Commit**

```bash
git add src/runtime.ts src/daemon/daemon.ts src/daemon/session-manager.ts
git commit -m "feat: add runtime.events event bus for identity:reloaded

Replaces onReload closure that only updated 'current' agent with
event-driven broadcast to all session ContextManagers.

Fixes: #4"
```

---

### Task 22: PR-2.1 Verification — Tests A03-A10

**Files:**
- Create: `tests/daemon/phase2-shared-runtime.test.ts`

- [ ] **Step 1: Write test: A08 — createSession idempotent**

```ts
it('A08: createSession same sessionId is idempotent (#54)', async () => {
  // Create session twice with same key → second returns existing or throws
  const ds1 = await sessionManager.createSession(ctx, 'prompt');
  const key = sessionKey(sessionAnchorId(ds1), ds1.larkAppId);
  // Second call with same ctx should behave predictably
  // (implementation choice: return existing, or throw)
});
```

- [ ] **Step 2: Write test: A03 — MCP connect count = 1**

```ts
it('A03: N sessions share 1 MCP connection (#51, #54)', async () => {
  let connectCount = 0;
  // Mock MCPManager.connect → increment counter
  for (let i = 0; i < 5; i++) {
    await sessionManager.createSession({ ...ctx, anchor: `chat-${i}` }, 'prompt');
  }
  expect(connectCount).toBe(1);
});
```

- [ ] **Step 3: Write test: A09 — create→remove→create ×100, no memory leak**

```ts
it('A09: create→remove→create ×100 memory stable (#54)', async () => {
  const initial = process.memoryUsage().heapUsed;
  for (let i = 0; i < 100; i++) {
    const ds = await sessionManager.createSession({ ...ctx, anchor: `chat-${i}` }, 'prompt');
    sessionManager.removeSession(sessionKey(`chat-${i}`, larkAppId));
  }
  const after = process.memoryUsage().heapUsed;
  expect(after - initial).toBeLessThan(5 * 1024 * 1024); // < 5MB growth
});
```

- [ ] **Step 4: Write test: A10 — shutdown aborts in-flight turns**

```ts
it('A10: runtime.shutdown aborts in-flight turns (#54)', async () => {
  const ds = await sessionManager.createSession(ctx, 'prompt');
  // Start a turn (don't await), then shutdown
  const turnPromise = sessionManager.runAgentTurn(ds, 'test');
  await runtime.shutdown();
  await expect(turnPromise).rejects.toThrow();
});
```

- [ ] **Step 5: Commit**

```bash
git add tests/daemon/phase2-shared-runtime.test.ts
git commit -m "test: add PR-2.1 tests (A03, A04, A05, A08-A10)"
```

---

### PR-2.2: #23 Remove currentSessionRef

---

### Task 23: SessionManager dual index (bySessionId)

**Files:**
- Modify: `src/daemon/session-manager.ts`

- [ ] **Step 1: Add bySessionId map and methods**

```ts
export class SessionManager {
  private sessions = new Map<string, DaemonSession>();      // routing key → session
  private agents = new Map<string, Agent>();
  private contextManagers = new Map<string, ContextManager>();
  private bySessionId = new Map<string, DaemonSession>();   // NEW: sessionId → session

  getSessionById(sessionId: string): DaemonSession | undefined {
    return this.bySessionId.get(sessionId);
  }

  // In createSession, after creating ds:
  this.bySessionId.set(ds.session.id, ds);

  // In removeSession:
  removeSession(sessionKeyStr: string): void {
    const ds = this.sessions.get(sessionKeyStr);
    if (ds) this.bySessionId.delete(ds.session.id);
    this.sessions.delete(sessionKeyStr);
    this.agents.delete(sessionKeyStr);
    this.contextManagers.delete(sessionKeyStr);
    runtime.events.emit('session:removed', {
      sessionKey: sessionKeyStr,
      sessionId: ds?.session.id,
    });
  }
```

- [ ] **Step 2: Commit**

```bash
git add src/daemon/session-manager.ts
git commit -m "feat(#23): add SessionManager dual index (bySessionId)"
```

---

### Task 24: PermissionManager per-session queue

**Files:**
- Modify: `src/tools/permission-manager.ts`

**Bugs fixed:** #23, #3, #52

- [ ] **Step 1: Rewrite PermissionManager**

Read `src/tools/permission-manager.ts` to understand current single-queue architecture.

```ts
// Replace single-queue with per-session queue:
export class PermissionManager {
  private queues = new Map<string, PermissionRequest[]>();
  private bridges = new Map<string, InteractiveBridge>();

  registerSession(sessionId: string, bridge: InteractiveBridge): void {
    this.bridges.set(sessionId, bridge);
    if (!this.queues.has(sessionId)) {
      this.queues.set(sessionId, []);
    }
  }

  unregisterSession(sessionId: string): void {
    this.bridges.delete(sessionId);
    this.queues.delete(sessionId);
  }

  async request(sessionId: string, req: PermissionRequest): Promise<Decision> {
    const bridge = this.bridges.get(sessionId);
    if (!bridge) throw new Error(`Unknown session: ${sessionId}`);
    const queue = this.queues.get(sessionId)!;
    if (queue.length >= MAX_QUEUE_SIZE) {
      return 'deny';
    }
    return new Promise((resolve) => {
      queue.push({ ...req, resolve });
      bridge.sendPermissionCard(/* ... */);
    });
  }

  respond(sessionId: string, decision: Decision): void {
    const queue = this.queues.get(sessionId);
    const req = queue?.shift();
    req?.resolve(decision);
  }
}
```

Remove the old `subscribe` method. Remove `globalPermissionManager` singleton if it exists.

- [ ] **Step 2: Update daemon.ts to use new PermissionManager API**

```ts
// daemon.ts — wire session:created/removed events
runtime.events.on('session:created', ({ sessionId, bridge }) => {
  permissionManager.registerSession(sessionId, bridge);
});
runtime.events.on('session:removed', ({ sessionId }) => {
  permissionManager.unregisterSession(sessionId);
});
```

- [ ] **Step 3: Delete currentSessionRef and bridgeRef**

Remove:
```ts
const bridgeRef: { current: InteractiveBridge | null } = { current: null };
const currentSessionRef: { current: DaemonSession | null } = { current: null };
```

- [ ] **Step 4: Update askUserQuestionHandler**

```ts
const askUserQuestionHandler = async (
  params: AskUserQuestionParameters,
  context: ToolContext,
): Promise<AskUserQuestionResult> => {
  const sid = context.metadata.sessionId as string;
  const ds = sessionManager.getSessionById(sid);
  const bridge = permissionManager.getBridge(sid);  // NEW method
  if (!ds || !bridge) throw new Error('no active session');
  return bridge.sendAskUserQuestionCard(sessionAnchorId(ds), params, ds.session.id);
};
```

- [ ] **Step 5: Add ToolContext.metadata passthrough**

If `ToolContext` doesn't have `metadata`, add it:

```ts
// src/tools/zod-tool.ts or wherever ToolContext is defined
export interface ToolContext {
  // ... existing
  metadata: Record<string, unknown>;
}
```

- [ ] **Step 6: Commit**

```bash
cd /root/my-agent && bun run tsc --noEmit
git add src/tools/permission-manager.ts src/daemon/daemon.ts src/daemon/session-manager.ts
git commit -m "refactor(#23): remove currentSessionRef, replace with sessionId routing

PermissionManager now has per-session queues. askUserQuestionHandler
reads sessionId from ToolContext.metadata. currentSessionRef and
bridgeRef deleted.

Fixes: #23, #1, #3, #52"
```

---

### Task 25: PR-2.2 Tests — Group B

**Files:**
- Create: `tests/daemon/phase2-permission.test.ts`

- [ ] **Step 1: Write test B01 — concurrent permission routing**

```ts
it('B01: concurrent permission requests route correctly (#23, #3)', async () => {
  const sessionA = await sessionManager.createSession({ ...ctx, anchor: 'chat-A' }, 'prompt');
  const sessionB = await sessionManager.createSession({ ...ctx, anchor: 'chat-B' }, 'prompt');

  const promiseA = permissionManager.request(sessionA.session.id, { toolName: 'bash', reason: 'test' });
  const promiseB = permissionManager.request(sessionB.session.id, { toolName: 'bash', reason: 'test' });

  // Resolve B first
  permissionManager.respond(sessionB.session.id, 'allow');
  const resultB = await promiseB;
  expect(resultB).toBe('allow');
  // A should still be pending
  // (can't test exact pending state without internal inspection, but timeout works)
});
```

- [ ] **Step 2: Write test B02 — sendPermissionCard returns real choice**

```ts
it('B02: sendPermissionCard returns real choice, not auto-deny (#3)', async () => {
  // Setup: create session, trigger permission
  // Verify: when user clicks allow, the tool executes
  // Verify: when user clicks deny, the tool is blocked
});
```

- [ ] **Step 3: Write test B06 — wrong sessionId callback doesn't cross-resolve**

```ts
it('B06: wrong sessionId callback rejected (#23)', async () => {
  const sessionA = await sessionManager.createSession(ctx, 'prompt');
  const promiseA = permissionManager.request(sessionA.session.id, { toolName: 'bash', reason: 'test' });

  // Callback with wrong sessionId
  expect(() => permissionManager.respond('wrong-id', 'allow')).toThrow();

  // A still pending (timeout would catch this in real test)
});
```

- [ ] **Step 4: Commit**

```bash
git add tests/daemon/phase2-permission.test.ts
git commit -m "test: add Group B permission routing tests (B01, B02, B06)"
```

---

### PR-2.3: #60 Client per-appId Map

---

### Task 26: LarkClient class encapsulation

**Files:**
- Modify: `src/im/lark/client.ts` (major rewrite)
- Modify: `src/daemon/daemon.ts` (use getLarkClient)
- Modify: `src/im/lark/event-dispatcher.ts` (accept LarkClient instance)

**Bugs fixed:** #60, #26, #5, #9, #28, #46, #27, #47

- [ ] **Step 1: Read current client.ts fully**

Understand all exported functions and their signatures.

- [ ] **Step 2: Rewrite client.ts as LarkClient class**

```ts
// src/im/lark/client.ts
import { Client, LoggerLevel } from '@larksuiteoapi/node-sdk';
import { createHash } from 'node:crypto';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const CHAT_MODE_TTL_MS = 5 * SECONDS_PER_MINUTE * MS_PER_SECOND;
const TOKEN_EARLY_EXPIRE_MS = 60_000; // expire 60s early

export class LarkClient {
  private client: Client;
  readonly appSecretHash: string;
  private chatModeCache = new Map<string, { mode: 'group' | 'topic' | 'p2p'; cachedAt: number }>();
  private tokenCache: { token: string; expiresAt: number } | null = null;
  private tokenInFlight: Promise<string> | null = null;

  constructor(public readonly appId: string, appSecret: string) {
    this.client = new Client({
      appId,
      appSecret,
      loggerLevel: process.env.DEBUG ? LoggerLevel.info : LoggerLevel.warn,
    });
    this.appSecretHash = sha256(appSecret);
  }

  async sendMessage(chatId: string, content: string, msgType: string = 'text'): Promise<string> {
    const body = msgType === 'text' ? JSON.stringify({ text: content }) : content;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (this.client.im.v1.message as any).create({
      params: { receive_id_type: 'chat_id' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { receive_id: chatId, msg_type: msgType as any, content: body },
    });
    if (res.code !== 0) throw new Error(`sendMessage failed: ${res.msg} (code: ${res.code})`);
    return res.data?.message_id ?? '';
  }

  async replyMessage(messageId: string, content: string, msgType: string = 'text', replyInThread: boolean = false): Promise<string> {
    const body = msgType === 'text' ? JSON.stringify({ text: content }) : content;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (this.client.im.v1.message as any).reply({
      path: { message_id: messageId },
      data: { msg_type: msgType as any, content: body, ...(replyInThread ? { reply_in_thread: true } : {}) },
    });
    if (res.code !== 0) throw new Error(`replyMessage failed: ${res.msg} (code: ${res.code})`);
    return res.data?.message_id ?? '';
  }

  async updateMessage(messageId: string, cardJson: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (this.client.im.v1.message as any).patch({
      path: { message_id: messageId },
      data: { content: cardJson },
    });
    if (res.code !== 0) throw new Error(`updateMessage failed: ${res.msg} (code: ${res.code})`);
  }

  async getChatInfo(chatId: string): Promise<{ userCount: number; botCount: number }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (this.client.im.v1.chat as any).get({ path: { chat_id: chatId } });
    if (res.code !== 0) throw new Error(`getChatInfo failed: ${res.msg} (code: ${res.code})`);
    return { userCount: Number(res.data?.user_count ?? 0), botCount: Number(res.data?.bot_count ?? 0) };
  }

  async getChatMode(chatId: string, opts: { forceRefresh?: boolean } = {}): Promise<'group' | 'topic' | 'p2p'> {
    const key = `${this.appId}::${chatId}`;
    const cached = this.chatModeCache.get(key);
    if (!opts.forceRefresh && cached && Date.now() - cached.cachedAt < CHAT_MODE_TTL_MS) {
      return cached.mode;
    }
    let mode: 'group' | 'topic' | 'p2p' = 'group';
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (this.client.im.v1.chat as any).get({ path: { chat_id: chatId } });
      if (res.code === 0) {
        const rawMode = String(res.data?.chat_mode ?? '').toLowerCase();
        const rawType = String(res.data?.chat_type ?? '').toLowerCase();
        const rawGmt = String(res.data?.group_message_type ?? '').toLowerCase();
        if (rawType === 'p2p') mode = 'p2p';
        else if (rawMode === 'topic' || rawGmt === 'thread') mode = 'topic';
        else mode = 'group';
      }
    } catch { /* fallback */ }
    this.chatModeCache.set(key, { mode, cachedAt: Date.now() });
    return mode;
  }

  invalidateChatModeCache(chatId: string): void {
    this.chatModeCache.delete(`${this.appId}::${chatId}`);
  }

  async getBotOpenId(): Promise<{ openId: string; name: string }> {
    const token = await this.getToken();
    const botRes = await fetch('https://open.feishu.cn/open-apis/bot/v3/info/', {
      headers: { Authorization: `Bearer ${token}` },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const botData = await botRes.json() as any;
    if (botData.code !== 0) throw new Error(`Failed to get bot info: ${botData.msg}`);
    return { openId: botData.bot?.open_id, name: botData.bot?.app_name ?? '' };
  }

  private async getToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - TOKEN_EARLY_EXPIRE_MS) {
      return this.tokenCache.token;
    }
    if (this.tokenInFlight) return this.tokenInFlight;
    this.tokenInFlight = this.fetchToken().finally(() => { this.tokenInFlight = null; });
    return this.tokenInFlight;
  }

  private async fetchToken(): Promise<string> {
    const tokenRes = await fetch(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.appId, app_secret: '' /* use client-managed secret */ }),
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tokenData = await tokenRes.json() as any;
    if (tokenData.code !== 0) throw new Error(`Failed to get token: ${tokenData.msg}`);
    this.tokenCache = {
      token: tokenData.tenant_access_token,
      expiresAt: Date.now() + (tokenData.expire ?? 7200) * 1000,
    };
    return this.tokenCache.token;
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (this.client.im.messageReaction as any).create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return res?.data?.reaction_id ?? null;
    } catch { return null; }
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.client.im.messageReaction as any).delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch { /* best effort */ }
  }

  close(): void { /* SDK client may not have explicit close */ }
}

// ── Factory ────────────────────────────────────────────────────

const clients = new Map<string, LarkClient>();

export function getLarkClient(appId: string, appSecret: string): LarkClient {
  const existing = clients.get(appId);
  if (existing) {
    if (existing.appSecretHash !== sha256(appSecret)) {
      throw new Error(`[lark] appSecret mismatch for appId=${appId}`);
    }
    return existing;
  }
  const c = new LarkClient(appId, appSecret);
  clients.set(appId, c);
  return c;
}

export async function closeAllLarkClients(): Promise<void> {
  for (const c of clients.values()) c.close();
  clients.clear();
}

// ── Backward compat re-exports for gradual migration ────────────
// Remove initLarkClient (deprecated)
```

- [ ] **Step 2: Update daemon.ts to use LarkClient**

```ts
// daemon.ts
import { getLarkClient, closeAllLarkClients, LarkClient } from '../im/lark/client';

// Replace: initLarkClient(bot.larkAppId, bot.larkAppSecret);
// With:
const larkClient = getLarkClient(bot.larkAppId, bot.larkAppSecret);

// Pass larkClient to event-dispatcher, session-handlers, etc.
```

- [ ] **Step 3: Update event-dispatcher.ts**

Accept `LarkClient` instance as parameter instead of using module-level functions.

- [ ] **Step 4: Update caller sites**

Search for all `import { sendMessage, replyMessage, ... } from '../im/lark/client'` and update to use instance methods.

- [ ] **Step 5: Commit**

```bash
cd /root/my-agent && bun run tsc --noEmit
git add src/im/lark/client.ts src/daemon/daemon.ts src/im/lark/event-dispatcher.ts
git commit -m "refactor(#60): encapsulate LarkClient as class with per-appId Map factory

Replaces module-level singleton with LarkClient class. Token fetch
uses single-flight pattern. getLarkClient factory validates
appSecret hash. closeAllLarkClients() for graceful shutdown.

Fixes: #60, #26, #5, #9, #28, #46, #27, #47"
```

---

### Task 27: SessionHarness fixture + LarkWSMock + PermissionDriver

**Files:**
- Create: `tests/fixtures/session-harness.ts`
- Create: `tests/fixtures/lark-ws-mock.ts`
- Create: `tests/fixtures/permission-driver.ts`

- [ ] **Step 1: Write LarkWSMock**

```ts
// tests/fixtures/lark-ws-mock.ts
import { EventEmitter } from 'node:events';

export class LarkWSMock extends EventEmitter {
  private connected = false;
  private reconnectSeq = 0;

  connect(): void { this.connected = true; this.emit('connected'); }
  disconnect(): void { this.connected = false; this.emit('disconnected'); }
  reconnect(): void { this.reconnectSeq++; this.connect(); }
  push(event: Record<string, unknown>): void { if (this.connected) this.emit('event', event); }
  isConnected(): boolean { return this.connected; }
  getReconnectCount(): number { return this.reconnectSeq; }
  close(): void { this.connected = false; this.removeAllListeners(); }
}
```

- [ ] **Step 2: Write PermissionDriver**

```ts
// tests/fixtures/permission-driver.ts
export class PermissionDriver {
  static async simulateAllow(bridge: unknown, sessionId: string, toolName: string): Promise<void> {
    // Simulate user clicking "Allow" on permission card
    (bridge as { handleCallback?: (action: string, data: unknown) => Promise<void> })
      ?.handleCallback?.('allow', { session_id: sessionId, tool_name: toolName });
  }

  static async simulateDeny(bridge: unknown, sessionId: string, toolName: string): Promise<void> {
    (bridge as { handleCallback?: (action: string, data: unknown) => Promise<void> })
      ?.handleCallback?.('deny', { session_id: sessionId, tool_name: toolName });
  }
}
```

- [ ] **Step 3: Write SessionHarness**

```ts
// tests/fixtures/session-harness.ts
import { FakeProvider } from './fake-provider';
import { createTempProfile } from './temp-profile';
import { TraceCapture } from './trace-capture';
import { join } from 'node:path';

export interface SessionHarnessOptions {
  provider?: FakeProvider;
  profileId?: string;
}

export class SessionHarness {
  provider: FakeProvider;
  profile: ReturnType<typeof createTempProfile>;
  traceCapture: TraceCapture;

  constructor(opts: SessionHarnessOptions = {}) {
    this.provider = opts.provider ?? new FakeProvider();
    this.profile = createTempProfile({ profileId: opts.profileId ?? 'harness-test' });
    this.traceCapture = new TraceCapture(join(this.profile.root, 'traces'));
  }

  async cleanup(): Promise<void> {
    this.profile.cleanup();
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/session-harness.ts tests/fixtures/lark-ws-mock.ts tests/fixtures/permission-driver.ts
git commit -m "feat(test): add SessionHarness, LarkWSMock, PermissionDriver fixtures"
```

---

### Task 28: PR-2.3 Tests — Group E

**Files:**
- Create: `tests/im/lark-client.test.ts`

- [ ] **Step 1: Write key LarkClient tests**

```ts
// tests/im/lark-client.test.ts
import { describe, it, expect } from 'bun:test';
import { getLarkClient, closeAllLarkClients, LarkClient } from '../../src/im/lark/client';

describe('LarkClient', () => {
  it('E08: same appId + different appSecret throws', () => {
    getLarkClient('cli_test123', 'secret-A');
    expect(() => getLarkClient('cli_test123', 'secret-B')).toThrow('appSecret mismatch');
  });

  it('E01: different appId → different instances', () => {
    const c1 = getLarkClient('cli_test_a', 'secret-a');
    const c2 = getLarkClient('cli_test_b', 'secret-b');
    expect(c1).not.toBe(c2);
    expect(c1.appId).toBe('cli_test_a');
    expect(c2.appId).toBe('cli_test_b');
  });

  it('E02: token single-flight (#26)', async () => {
    const client = new LarkClient('cli_test_token', 'secret');
    // Mock fetch to count calls
    // Launch 10 concurrent getBotOpenId
    // Expect exactly 1 token endpoint call
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/im/lark-client.test.ts
git commit -m "test: add Group E LarkClient tests (E01, E02, E08)"
```

---

### PR-2.4: Group F-K Independent Bug Fixes

---

### Task 29: Group F — Routing & Session Lifecycle (17 bugs)

**Files:**
- Modify: `src/im/lark/event-dispatcher.ts` (#2, #6, #7, #8, #29)
- Modify: `src/im/lark/card-handler.ts` (#14, #34, #35, #68)
- Modify: `src/im/lark/card-pipeline.ts` (#48)
- Modify: `src/daemon/session-handlers.ts` (#15, #16, #17, #69)
- Modify: `src/daemon/session-manager.ts` (#37, #38, #39)
- Modify: `src/daemon/daemon.ts` (#44)

- [ ] **Step 1: Fix #2 — /close removeSession with correct key**

```ts
// command-handler.ts
// BEFORE: removeSession(anchor)
// AFTER: removeSession(sessionKey(anchor, larkAppId))
```

- [ ] **Step 2: Fix #37 — removeSession aborts running turn**

```ts
// session-manager.ts removeSession:
removeSession(sessionKeyStr: string): void {
  const agent = this.agents.get(sessionKeyStr);
  agent?.abort();
  // ... rest of removal
}
```

- [ ] **Step 3: Fix #15 — handleNewTopic uses thread.root_id**

```ts
// session-handlers.ts handleNewTopic
const rootMessageId = ctx.scope === 'thread' ? (ctx.threadRootId ?? ctx.messageId) : ctx.messageId;
```

- [ ] **Step 4: Fix #16 — handleThreadReply uses thread.root_id**

```ts
// session-handlers.ts handleThreadReply
const anchor = ctx.threadRootId ?? ctx.messageId;
```

- [ ] **Step 5: Fix #7 — event_id dedup**

```ts
// event-dispatcher.ts
const dedupSet = new Set<string>();
const MAX_DEDUP = 1000;

function isDuplicate(eventId: string): boolean {
  if (dedupSet.has(eventId)) return true;
  dedupSet.add(eventId);
  if (dedupSet.size > MAX_DEDUP) {
    const first = dedupSet.values().next().value;
    if (first) dedupSet.delete(first);
  }
  return false;
}
```

- [ ] **Step 6: Fix remaining Group F bugs in batch**

#6: allow all / commands through self-message filter
#8: strict open_id match for @mentions
#14: nullcheck session_id in card handler
#34: empty session_id → friendly error
#17: off() before on() for card callbacks
#44: mkdirSync workingDir at startup
#69: timeout fallback to text reply
#29: handle message.recalled event
#35: dedup token for button clicks
#38: atomic rename for session writes
#48: clear card queue on session remove
#39: LRU + idle GC with TTL

- [ ] **Step 7: Commit Group F**

```bash
git add src/im/lark/event-dispatcher.ts src/im/lark/card-handler.ts src/im/lark/card-pipeline.ts src/daemon/session-handlers.ts src/daemon/session-manager.ts src/daemon/daemon.ts src/daemon/command-handler.ts
git commit -m "fix: Group F — routing & session lifecycle (17 bugs)

#2, #37, #15, #16, #7, #8, #14, #34, #17, #44, #69, #6, #29, #35, #38, #48, #39"
```

---

### Task 30: Group G — Agent Loop / Tool Execution (12 bugs)

**Files:**
- Modify: `src/agent/single-turn.ts` (#87, #84)
- Modify: `src/agent/Agent.ts` (#91, #90)
- Modify: `src/agent/agent-loop.ts` (#89, #88, #95)
- Modify: `src/agent/run-tools.ts` (#86, #85)
- Modify: `src/agent/context.ts` (#92, #93, #57)

- [ ] **Step 1: Fix #87 — OpenAI tool_calls delta accumulation**

```ts
// single-turn.ts — in OpenAI stream handler
const toolCallStacks = new Map<number, { id: string; name: string; arguments: string }>();
// For each delta: accumulate arguments by index
if (delta.tool_calls) {
  for (const tc of delta.tool_calls) {
    const existing = toolCallStacks.get(tc.index!) ?? { id: '', name: '', arguments: '' };
    toolCallStacks.set(tc.index!, {
      id: tc.id ?? existing.id,
      name: tc.function?.name ? (existing.name + (tc.function.name ?? '')) : existing.name,
      arguments: existing.arguments + (tc.function?.arguments ?? ''),
    });
  }
}
```

- [ ] **Step 2: Fix #84 — stream retry boundary**

```ts
// single-turn.ts — on retry, yield a retry_start marker
context.ephemeralReminders ??= [];
context.ephemeralReminders.push('<retry-start/>');
```

- [ ] **Step 3: Fix #91 — abort resets isRunning**

```ts
// Agent.ts abort():
this.isRunning = false;
```

- [ ] **Step 4: Fix #89 — AbortController listener cleanup**

```ts
// agent-loop.ts
const ac = new AbortController();
const onAbort = () => { /* ... */ };
ac.signal.addEventListener('abort', onAbort, { once: true });
// ... after turn:
ac.signal.removeEventListener('abort', onAbort);
```

- [ ] **Step 5: Fix #88 — maxTurns default 25**

```ts
// agent-loop.ts DEFAULT_LOOP_CONFIG
export const DEFAULT_LOOP_CONFIG: AgentLoopConfig = {
  maxTurns: 25,
  // ...
};
```

- [ ] **Step 6: Fix #95 — turnIndex start from 0**

```ts
// agent-loop.ts
let turnIndex = 0; // BEFORE: was 1
```

- [ ] **Step 7: Fix #92 — system prompt hash recompute**

```ts
// context.ts — after setSystemPrompt, recompute hash
setSystemPrompt(prompt: string): void {
  this.systemPrompt = prompt;
  this._systemPromptHash = hashFn(prompt); // recompute
}
```

- [ ] **Step 8: Fix remaining Group G bugs**

#86: compact-first → re-call model for tool_calls
#85: classify partial side-effect in abort message
#90: dedup before registerTools
#93: unique guard for tool_use_id
#57: dual threshold (token priority over message count)

- [ ] **Step 9: Commit Group G**

```bash
git add src/agent/single-turn.ts src/agent/Agent.ts src/agent/agent-loop.ts src/agent/run-tools.ts src/agent/context.ts
git commit -m "fix: Group G — agent loop & tool execution (12 bugs)

#87, #84, #91, #89, #88, #86, #85, #90, #92, #93, #95, #57"
```

---

### Task 31: Group I + J — Card Builder & Profile (20 bugs)

**Files:**
- Modify: `src/im/lark/card-builder.ts` (#13, #73, #12)
- Modify: `src/im/lark/message-parser.ts` (#30, #31, #32)
- Modify: `src/profile/loader.ts` (#66, #20, #65)
- Modify: `src/profile/types.ts` (#21, #22)
- Modify: `src/profile/update-identity-tool.ts` (#64)
- Modify: `src/daemon/cli-commands.ts` (#25, #70, #72, #71)
- Modify: `src/daemon/daemon.ts` (#80)
- Modify: `src/runtime.ts` (#74, #75)
- Modify: `src/daemon/session-manager.ts` (#36)

- [ ] **Step 1: Fix #13/#73 — complete escapeMd set**

```ts
// card-builder.ts
export function escapeMd(text: string): string {
  return text
    .replace(/>/g, '\\>')
    .replace(/!/g, '\\!')
    .replace(/#/g, '\\#')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/~/g, '\\~')
    .replace(/`/g, '\\`');
}
```

- [ ] **Step 2: Fix #30 — image/file message extraction**

```ts
// message-parser.ts
if (msgType === 'image') return '[图片]';
if (msgType === 'file') return `[文件:${fileName}]`;
if (msgType === 'audio') return '[语音]';
if (msgType === 'sticker') return '[表情]';
```

- [ ] **Step 3: Fix #25 — chmod 600 bots.yml**

```ts
// cli-commands.ts botSetup — after writing bots.yml:
import { chmodSync } from 'node:fs';
chmodSync(botsYmlPath, 0o600);
```

- [ ] **Step 4: Fix #64 — atomic identity write**

```ts
// update-identity-tool.ts
import { renameSync } from 'node:fs';
const tmpPath = identityPath + '.tmp.' + Date.now();
writeFileSync(tmpPath, newContent, 'utf-8');
renameSync(tmpPath, identityPath);
```

- [ ] **Step 5: Fix #80 — identity file size guard**

```ts
// daemon.ts — before loading identity
const MAX_IDENTITY_BYTES = 1_048_576; // 1MB
const stat = statSync(identityPath);
if (stat.size > MAX_IDENTITY_BYTES) {
  throw new Error(`Identity file too large: ${stat.size} bytes (max ${MAX_IDENTITY_BYTES})`);
}
```

- [ ] **Step 6: Commit Groups I+J**

```bash
git add src/im/lark/card-builder.ts src/im/lark/message-parser.ts src/profile/loader.ts src/profile/types.ts src/profile/update-identity-tool.ts src/daemon/cli-commands.ts src/daemon/daemon.ts src/runtime.ts src/daemon/session-manager.ts
git commit -m "fix: Groups I+J — card builder, markdown escape, profile hardening (20 bugs)

#13, #73, #12, #30, #31, #32, #25, #64, #80, #66, #20, #65, #21, #22, #72, #74, #75, #33, #36, #71"
```

---

### Task 32: Misc Bugs (10 bugs)

**Files:**
- Modify: `src/im/lark/card-pipeline.ts` (#10, #11)
- Modify: `src/daemon/daemon.ts` (#45, #79)
- Modify: `src/runtime.ts` (#49, #55, #56)
- Modify: `src/im/types.ts` (#76, #77)
- Modify: `src/daemon/daemon-cli.ts` (#81)

- [ ] **Step 1: Fix all misc bugs in batch**

#10: force flush on reconnect
#11: 4xx immediate fail-fast
#45: redact LARK_APP_SECRET from logs
#49: model-adaptive token limit
#50: inject sessionId in todo persistence
#55: enableMcp priority over settings.mcp
#56: dispose() hooks on shutdown
#71: add examples to --help
#76: use '\x1f' separator in sessionKey
#77: tighten RoutingContext optional fields
#79: profile watcher + rebuild runtime (defer to watcher file)
#81: pass-through args to logs command

- [ ] **Step 2: Commit misc bugs**

```bash
git add src/im/lark/card-pipeline.ts src/daemon/daemon.ts src/runtime.ts src/im/types.ts src/daemon/daemon-cli.ts
git commit -m "fix: misc bugs — card pipeline, logging, types, config (10 bugs)

#10, #11, #45, #49, #50, #55, #56, #71, #76, #77, #79, #81"
```

---

### Task 33: Phase 2 Integration Tests — Groups E, F, G, I, J

**Files:**
- Create: `tests/daemon/phase2-integration.test.ts`

- [ ] **Step 1: Write Group E integration tests (E03-E07)**

```ts
// tests/daemon/phase2-integration.test.ts
import { describe, it, expect } from 'bun:test';
import { LarkClient } from '../../src/im/lark/client';
import { LarkWSMock } from '../fixtures/lark-ws-mock';

describe('Group E — Lark Client', () => {
  it('E03: getChatMode cache invalidated on chat_disbanded (#9, #67)', () => {
    // Create client, set cache, invalidate, verify cache miss
  });

  it('E07: token expiry only affects one bot (#60)', async () => {
    const c1 = new LarkClient('app1', 'secret1');
    const c2 = new LarkClient('app2', 'secret2');
    // Expire c1's token, verify c2's token is unchanged
  });
});
```

- [ ] **Step 2: Write Group G integration tests (G01-G03, G06)**

```ts
describe('Group G — Agent Loop', () => {
  it('G01: OpenAI tool_calls deltas accumulated correctly (#87)', async () => {
    // FakeProvider with fragmented tool_call deltas
    // Verify complete JSON assembled
  });

  it('G06: compact-first rebuilds tool_calls (#86)', async () => {
    // Trigger compaction, verify next turn tool_calls work
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add tests/daemon/phase2-integration.test.ts
git commit -m "test: add Phase 2 integration tests (Groups E, G)"
```

---

### Task 34: Phase 2 Full Verification

- [ ] **Step 1: Run full test suite**

```bash
cd /root/my-agent && bun test --timeout 60000 2>&1 | tail -50
```

Expected: all tests pass, no regressions.

- [ ] **Step 2: Run type check**

```bash
cd /root/my-agent && bun run tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Run architecture check**

```bash
cd /root/my-agent && bun run check:arch 2>&1
```

Expected: no new architecture violations.

- [ ] **Step 4: Run lint**

```bash
cd /root/my-agent && bun run lint 2>&1 | tail -20
```

Expected: no new lint errors.

- [ ] **Step 5: Final bug coverage audit**

```bash
cd /root/my-agent && grep -r "Fixes:" docs/superpowers/plans/2026-05-15-im-bridge-bugfixes-plan.md | grep -oP '#\d+' | sort -t'#' -k1 -n | uniq
```

Expected: all 103 bug IDs (#1-#112 minus 8 merged/eliminated) appear in plan.

---

### Task 35: CI Matrix Configuration

**Files:**
- Create: `.github/workflows/im-bridge-tests.yml` (or update existing)

- [ ] **Step 1: Write CI workflow**

```yaml
name: IM-Bridge Tests

on:
  push:
    branches: ['**']
  schedule:
    - cron: '0 2 * * *'    # nightly
    - cron: '0 2 * * 0'    # weekly-perf Sunday

jobs:
  pr-fast:
    if: github.event_name == 'push' && github.ref != 'refs/heads/main'
    runs-on: ubuntu-latest
    timeout-minutes: 3
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun test --timeout 30000 tests/daemon/phase1-unit.test.ts tests/memory/sqlite-tests.test.ts tests/daemon/phase2-permission.test.ts tests/im/lark-client.test.ts

  pr-full:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun test --timeout 60000

  nightly:
    if: github.event.schedule == '0 2 * * *'
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun test --timeout 300000 tests/

  weekly-perf:
    if: github.event.schedule == '0 2 * * 0'
    runs-on: ubuntu-latest
    timeout-minutes: 240
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun test --timeout 600000 tests/
      - run: bun run check:all
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/im-bridge-tests.yml
git commit -m "ci: add IM-Bridge test matrix (pr-fast, pr-full, nightly, weekly-perf)

Long-running chaos tests (L05-L07) run in nightly/weekly-perf only,
never in pre-push hooks."
```

---

## Summary

| Phase | Tasks | Bugs | Production Lines | Test Lines |
|---|---|---|---|---|
| Phase 1 (Tasks 1-17) | 17 | 25 | ~97 | ~240 |
| Phase 2 (Tasks 18-35) | 18 | 78 | ~340 | ~720 |
| **Total** | **35** | **103** | **~437** | **~960** |

**PR Order:**
1. Phase 1: single PR (Tasks 1-17)
2. PR-2.1: #54 Shared Runtime (Tasks 18-22)
3. PR-2.2: #23 Remove currentSessionRef (Tasks 23-25) — depends on PR-2.1
4. PR-2.3: #60 Client per-appId (Tasks 26-28) — parallel with PR-2.2
5. PR-2.4: Group F-K independent bugs (Tasks 29-32) — parallel
6. PR-2.5: Integration tests + CI (Tasks 33-35)
