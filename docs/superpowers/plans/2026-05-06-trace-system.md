# Trace System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a middleware-based trace system that records agent loop execution (tool calls, LLM responses, errors, token usage, timing) with incremental NDJSON persistence, per-run TraceBuffer isolation, a 3-signal NudgeEngine, and configurable redaction.

**Architecture:** TraceAgentMiddleware uses 3 of 6 existing AgentHooks (beforeAgentRun for buffer init, beforeAddResponse for LLM recording, afterAgentRun for finalize+nudge). TraceToolMiddleware wraps tool execution at the innermost onion layer. TraceBuffer lives in AgentContext.metadata._traceBuffer for per-run isolation. NudgeEngine fires on error bursts, complex task completion, and periodic intervals — with fingerprint dedup.

**Tech Stack:** TypeScript, Bun test, nanoid (already in deps), Node.js fs/promises for NDJSON append

---

### Task 1: Add trace config types, defaults, schema, and loader merge

**Files:**
- Modify: `src/config/types.ts` (add TraceSettings, NudgeSettings interfaces)
- Modify: `src/config/defaults.ts` (add trace defaults)
- Modify: `src/config/schema.ts` (add Zod schemas)
- Modify: `src/config/loader.ts` (add trace merge in mergeConfigs)

- [ ] **Step 1: Add trace types to config/types.ts**

Add after the `DebugSettings` interface (before `Settings`):

```typescript
export interface TraceRedactionSettings {
  mode: 'default' | 'none';
}

export interface TraceNudgeSettings {
  enabled: boolean;
  reviewInterval: number;
}

export interface TraceSettings {
  enabled: boolean;
  maxRunsPerSession: number;
  redaction: TraceRedactionSettings;
  nudge: TraceNudgeSettings;
}
```

Add `trace: TraceSettings` to the `Settings` interface:

```typescript
export interface Settings {
  // ... existing fields ...
  debug: DebugSettings;
  mcp: McpSettings;
  trace: TraceSettings;
}
```

- [ ] **Step 2: Add trace defaults to config/defaults.ts**

Add after the `mcp` defaults block:

```typescript
trace: {
  enabled: true,
  maxRunsPerSession: 50,
  redaction: {
    mode: 'default' as const,
  },
  nudge: {
    enabled: true,
    reviewInterval: 10,
  },
},
```

- [ ] **Step 3: Add trace Zod schemas to config/schema.ts**

Add after the `debugSettingsSchema`:

```typescript
const traceRedactionSettingsSchema = z.object({
  mode: z.enum(['default', 'none']).default('default'),
});

const traceNudgeSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  reviewInterval: z.number().int().positive().default(10),
});

const traceSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  maxRunsPerSession: z.number().int().positive().default(50),
  redaction: traceRedactionSettingsSchema,
  nudge: traceNudgeSettingsSchema,
});
```

Add `trace: traceSettingsSchema` to `settingsSchema`:

```typescript
export const settingsSchema = z.object({
  // ... existing fields ...
  mcp: mcpSettingsSchema,
  trace: traceSettingsSchema,
});
```

- [ ] **Step 4: Add trace merge in config/loader.ts mergeConfigs**

Add after the `mcp` merge block (before the `return result`):

```typescript
if (user.trace) {
  result.trace = defaults.trace
    ? {
        ...defaults.trace,
        ...user.trace,
        redaction: defaults.trace.redaction
          ? { ...defaults.trace.redaction, ...user.trace.redaction }
          : user.trace.redaction,
        nudge: defaults.trace.nudge
          ? { ...defaults.trace.nudge, ...user.trace.nudge }
          : user.trace.nudge,
      }
    : { ...user.trace };
}
```

- [ ] **Step 5: Run type check to verify**

Run: `bun run tsc --noEmit`
Expected: PASS (no type errors)

- [ ] **Step 6: Commit**

```bash
git add src/config/types.ts src/config/defaults.ts src/config/schema.ts src/config/loader.ts
git commit -m "feat: add trace configuration types, defaults, and schema"
```

---

### Task 2: Create trace types (`src/trace/types.ts`)

**Files:**
- Create: `src/trace/types.ts`

- [ ] **Step 1: Write the types file**

```typescript
/** Core trace data model types for the middleware-based trace system. */

export interface TraceTurn {
  turnIndex: number;
  userMessage?: string;
  modelResponse?: {
    thinking?: string;
    text: string;
    toolCalls: Array<{
      name: string;
      arguments: Record<string, unknown>;
    }>;
    usage: Record<string, number>;
  };
  toolExecutions: Array<{
    toolName: string;
    success: boolean;
    durationMs: number;
    error?: string;
  }>;
  compaction?: {
    level: string;
    beforeTokens: number;
    afterTokens: number;
  };
}

export interface TraceSummary {
  totalTurns: number;
  totalToolCalls: number;
  totalErrors: number;
  totalTokens: Record<string, number>;
  outcome: 'completed' | 'error' | 'max_turns' | 'aborted';
  error?: string;
}

export interface TraceRun {
  id: string;
  sessionId: string;
  parentRunId?: string;
  startTime: number;
  endTime: number;
  model: string;
  turns: TraceTurn[];
  summary: TraceSummary;
}

/** One line in the NDJSON file. */
export type TraceEntry =
  | ({ type: 'turn'; turnIndex: number } & TraceTurn)
  | ({ type: 'tool' } & TraceTurn['toolExecutions'][number])
  | ({ type: 'summary' } & TraceSummary);

export interface TraceRedactor {
  redactToolArguments(toolName: string, args: Record<string, unknown>): Record<string, unknown>;
  redactText(text: string): string;
}

export interface NudgeState {
  turnsSinceReview: number;
  fingerprints: Record<string, string[]>;
  lastReviewAt: number;
}

export interface NudgeResult {
  trigger: 'memory_review' | 'skill_review' | 'combined_review';
  traceRunId: string;
  sessionId: string;
  fingerprint: string;
  reason: string;
}

export interface TraceStore {
  appendTurn(runId: string, sessionId: string, entry: TraceEntry): Promise<void>;
  finalize(trace: TraceRun): Promise<void>;
  get(runId: string, sessionId: string): Promise<TraceRun | null>;
  listBySession(sessionId: string, limit?: number): Promise<string[]>;
  listRecent(sessionLimit?: number, runLimit?: number): Promise<TraceRun[]>;
}
```

- [ ] **Step 2: Run type check**

Run: `bun run tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/trace/types.ts
git commit -m "feat: add trace data model types"
```

---

### Task 3: Implement TraceStore with NDJSON persistence

**Files:**
- Create: `src/trace/store.ts`
- Create: `tests/trace/store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { TraceStore } from '../../src/trace/store';
import type { TraceRun } from '../../src/trace/types';

const TEST_DIR = path.join(os.tmpdir(), `trace-store-test-${Date.now()}`);

function makeTrace(overrides: Partial<TraceRun> = {}): TraceRun {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    startTime: 1000,
    endTime: 2000,
    model: 'test-model',
    turns: [],
    summary: { totalTurns: 0, totalToolCalls: 0, totalErrors: 0, totalTokens: {}, outcome: 'completed' },
    ...overrides,
  };
}

describe('TraceStore', () => {
  let store: TraceStore;

  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
    store = new TraceStore(TEST_DIR);
  });

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  test('appendTurn writes a line to the NDJSON file', async () => {
    await store.appendTurn('run-1', 'session-1', {
      type: 'turn', turnIndex: 0, userMessage: 'hello', toolExecutions: [],
    });

    const filePath = path.join(TEST_DIR, 'session-1', 'run-1.jsonl');
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.type).toBe('turn');
    expect(parsed.turnIndex).toBe(0);
  });

  test('finalize writes summary line and stores completed trace', async () => {
    await store.appendTurn('run-1', 'session-1', {
      type: 'turn', turnIndex: 0, toolExecutions: [],
    });
    const trace = makeTrace({
      id: 'run-1', sessionId: 'session-1',
      turns: [{ turnIndex: 0, toolExecutions: [] }],
      summary: { totalTurns: 1, totalToolCalls: 0, totalErrors: 0, totalTokens: {}, outcome: 'completed' },
    });

    await store.finalize(trace);

    const filePath = path.join(TEST_DIR, 'session-1', 'run-1.jsonl');
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2);
    const summaryLine = JSON.parse(lines[1]!);
    expect(summaryLine.type).toBe('summary');
    expect(summaryLine.totalTurns).toBe(1);
  });

  test('get reconstructs a full TraceRun from NDJSON lines', async () => {
    await store.appendTurn('run-1', 'session-1', {
      type: 'turn', turnIndex: 0, userMessage: 'hello', toolExecutions: [],
    });
    await store.appendTurn('run-1', 'session-1', {
      type: 'tool', toolName: 'bash', success: true, durationMs: 42,
    });
    const trace = makeTrace({
      id: 'run-1', sessionId: 'session-1',
      turns: [{ turnIndex: 0, userMessage: 'hello', toolExecutions: [{ toolName: 'bash', success: true, durationMs: 42 }] }],
    });
    await store.finalize(trace);

    const reconstructed = await store.get('run-1', 'session-1');
    expect(reconstructed).not.toBeNull();
    expect(reconstructed!.turns.length).toBe(1);
    expect(reconstructed!.turns[0]!.toolExecutions.length).toBe(1);
    expect(reconstructed!.summary.outcome).toBe('completed');
  });

  test('listBySession returns run IDs newest first', async () => {
    const trace1 = makeTrace({ id: 'run-1', sessionId: 'session-1' });
    const trace2 = makeTrace({ id: 'run-2', sessionId: 'session-1' });
    await store.appendTurn('run-1', 'session-1', { type: 'turn', turnIndex: 0, toolExecutions: [] });
    await store.finalize(trace1);
    await store.appendTurn('run-2', 'session-1', { type: 'turn', turnIndex: 0, toolExecutions: [] });
    await store.finalize(trace2);

    const runs = await store.listBySession('session-1');
    expect(runs.length).toBe(2);
    expect(runs).toContain('run-1');
    expect(runs).toContain('run-2');
  });

  test('retention deletes oldest runs when exceeding maxRunsPerSession', async () => {
    store = new TraceStore(TEST_DIR, 2);
    for (let i = 0; i < 3; i++) {
      const runId = `run-${i}`;
      await store.appendTurn(runId, 'session-1', { type: 'turn', turnIndex: 0, toolExecutions: [] });
      await store.finalize(makeTrace({ id: runId, sessionId: 'session-1' }));
    }
    const runs = await store.listBySession('session-1');
    expect(runs.length).toBe(2);
    expect(runs).not.toContain('run-0');
  });

  test('get returns null for nonexistent run', async () => {
    const result = await store.get('nonexistent', 'session-1');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/trace/store.test.ts`
Expected: FAIL — "Cannot find module '../../src/trace/store'"

- [ ] **Step 3: Write minimal TraceStore implementation**

```typescript
import fs from 'fs/promises';
import path from 'path';
import type { TraceRun, TraceEntry, TraceTurn, TraceSummary } from './types';

const DEFAULT_MAX_RUNS = 50;

export class TraceStore {
  private baseDir: string;
  private maxRunsPerSession: number;

  constructor(baseDir: string, maxRunsPerSession: number = DEFAULT_MAX_RUNS) {
    this.baseDir = baseDir;
    this.maxRunsPerSession = maxRunsPerSession;
  }

  private runPath(runId: string, sessionId: string): string {
    return path.join(this.baseDir, sessionId, `${runId}.jsonl`);
  }

  async appendTurn(runId: string, sessionId: string, entry: TraceEntry): Promise<void> {
    const filePath = this.runPath(runId, sessionId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  async finalize(trace: TraceRun): Promise<void> {
    const summaryEntry: TraceEntry = { type: 'summary', ...trace.summary };
    await this.appendTurn(trace.id, trace.sessionId, summaryEntry);

    // Enforce retention
    const sessionDir = path.join(this.baseDir, trace.sessionId);
    const files = await fs.readdir(sessionDir);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
    if (jsonlFiles.length > this.maxRunsPerSession) {
      const sorted = jsonlFiles.sort();
      const toDelete = sorted.slice(0, jsonlFiles.length - this.maxRunsPerSession);
      for (const f of toDelete) {
        await fs.unlink(path.join(sessionDir, f)).catch(() => {});
      }
    }
  }

  async get(runId: string, sessionId: string): Promise<TraceRun | null> {
    const filePath = this.runPath(runId, sessionId);
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }

    const lines = content.trim().split('\n').filter(Boolean);
    const turns: TraceTurn[] = [];
    let summary: TraceSummary | undefined;

    for (const line of lines) {
      const entry = JSON.parse(line) as TraceEntry;
      if (entry.type === 'turn') {
        const { type, turnIndex, ...rest } = entry as TraceEntry & { type: 'turn' };
        turns.push({ turnIndex, ...rest });
      } else if (entry.type === 'tool') {
        const lastTurn = turns[turns.length - 1];
        if (lastTurn) {
          const { type, ...exec } = entry as TraceEntry & { type: 'tool' };
          lastTurn.toolExecutions.push(exec);
        }
      } else if (entry.type === 'summary') {
        const { type, ...sum } = entry as TraceEntry & { type: 'summary' };
        summary = sum;
      }
    }

    if (!summary) return null;

    return {
      id: runId,
      sessionId,
      startTime: 0,
      endTime: 0,
      model: '',
      turns,
      summary,
    };
  }

  async listBySession(sessionId: string, limit?: number): Promise<string[]> {
    const sessionDir = path.join(this.baseDir, sessionId);
    let files: string[];
    try {
      files = await fs.readdir(sessionDir);
    } catch {
      return [];
    }
    return files
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''))
      .sort()
      .reverse()
      .slice(0, limit ?? this.maxRunsPerSession);
  }

  async listRecent(sessionLimit = 10, runLimit?: number): Promise<TraceRun[]> {
    let sessionDirs: string[];
    try {
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
      sessionDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch {
      return [];
    }

    const runs: TraceRun[] = [];
    for (const sessionId of sessionDirs.slice(0, sessionLimit)) {
      const runIds = await this.listBySession(sessionId, runLimit ?? 5);
      for (const runId of runIds) {
        const run = await this.get(runId, sessionId);
        if (run) runs.push(run);
      }
    }
    return runs;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/trace/store.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/trace/store.ts tests/trace/store.test.ts
git commit -m "feat: add TraceStore with incremental NDJSON persistence and retention"
```

---

### Task 4: Implement TraceRedactor

**Files:**
- Create: `src/trace/redactor.ts`
- Create: `tests/trace/redactor.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from 'bun:test';
import { DefaultRedactor } from '../../src/trace/redactor';

describe('DefaultRedactor', () => {
  const redactor = new DefaultRedactor();

  test('redacts API key patterns in text', () => {
    const result = redactor.redactText('my key is sk-abc123xyz and ghp_token456');
    expect(result).not.toContain('sk-abc123xyz');
    expect(result).not.toContain('ghp_token456');
    expect(result).toContain('[REDACTED]');
  });

  test('redacts BEGIN/END private key blocks', () => {
    const input = 'key: -----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----';
    const result = redactor.redactText(input);
    expect(result).not.toContain('BEGIN PRIVATE KEY');
    expect(result).toContain('[REDACTED]');
  });

  test('does not redact normal text', () => {
    const input = 'The file is at /home/user/project/src/index.ts';
    const result = redactor.redactText(input);
    expect(result).toBe(input);
  });

  test('redacts API key in tool arguments', () => {
    const args = { apiKey: 'sk-abc123', name: 'test', nested: { token: 'ghp_secret' } };
    const result = redactor.redactToolArguments('some_tool', args);
    expect(result.apiKey).toBe('[REDACTED]');
    expect(result.name).toBe('test');
    expect((result.nested as Record<string, unknown>).token).toBe('[REDACTED]');
  });

  test('mode=none redacts nothing', () => {
    const noop = new DefaultRedactor('none');
    const result = noop.redactText('key is sk-abc123');
    expect(result).toBe('key is sk-abc123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/trace/redactor.test.ts`
Expected: FAIL — "Cannot find module '../../src/trace/redactor'"

- [ ] **Step 3: Write minimal DefaultRedactor implementation**

```typescript
import type { TraceRedactor } from './types';

const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9_-]{20,}\b/g,
  /\bghp_[a-zA-Z0-9]{20,}\b/g,
  /\bgho_[a-zA-Z0-9]{20,}\b/g,
  /\bghu_[a-zA-Z0-9]{20,}\b/g,
  /\bghs_[a-zA-Z0-9]{20,}\b/g,
  /\bxox[bpts]-[a-zA-Z0-9-]{20,}\b/g,
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
];

export class DefaultRedactor implements TraceRedactor {
  private mode: 'default' | 'none';

  constructor(mode: 'default' | 'none' = 'default') {
    this.mode = mode;
  }

  redactText(text: string): string {
    if (this.mode === 'none') return text;
    let result = text;
    for (const pattern of SECRET_PATTERNS) {
      result = result.replace(pattern, '[REDACTED]');
    }
    return result;
  }

  redactToolArguments(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
    if (this.mode === 'none') return args;
    return this.redactObject(args);
  }

  private redactObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        result[key] = this.isSecret(value) ? '[REDACTED]' : value;
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[key] = this.redactObject(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private isSecret(value: string): boolean {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(value)) return true;
    }
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/trace/redactor.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/trace/redactor.ts tests/trace/redactor.test.ts
git commit -m "feat: add DefaultRedactor with secret pattern redaction"
```

---

### Task 5: Implement TraceBuffer

**Files:**
- Create: `src/trace/trace-buffer.ts`
- Create: `tests/trace/trace-buffer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { TraceBuffer } from '../../src/trace/trace-buffer';
import { TraceStore } from '../../src/trace/store';

const TEST_DIR = path.join(os.tmpdir(), `trace-buffer-test-${Date.now()}`);

describe('TraceBuffer', () => {
  let store: TraceStore;

  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
    store = new TraceStore(TEST_DIR);
  });

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  test('creates buffer with runId, sessionId, and startTime', () => {
    const buffer = new TraceBuffer('session-1', store);
    expect(buffer.runId).toBeString();
    expect(buffer.runId.length).toBeGreaterThan(0);
    expect(buffer.sessionId).toBe('session-1');
  });

  test('recordModelResponse creates a new turn and appends NDJSON line', async () => {
    const buffer = new TraceBuffer('session-1', store);
    buffer.recordModelResponse({
      text: 'Hello world',
      toolCalls: [{ name: 'read', arguments: { file: 'test.ts' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    const trace = buffer.finalize('test-model');
    expect(trace.turns.length).toBe(1);
    expect(trace.turns[0]!.modelResponse!.text).toBe('Hello world');
    expect(trace.turns[0]!.modelResponse!.toolCalls.length).toBe(1);
  });

  test('recordToolExecution appends to current turn and writes NDJSON', async () => {
    const buffer = new TraceBuffer('session-1', store);
    buffer.recordModelResponse({
      text: 'Running tool', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    buffer.recordToolExecution({ toolName: 'bash', success: true, durationMs: 42 });
    buffer.recordToolExecution({ toolName: 'read', success: false, durationMs: 100, error: 'ENOENT' });

    const trace = buffer.finalize('test-model');
    expect(trace.turns[0]!.toolExecutions.length).toBe(2);
    expect(trace.turns[0]!.toolExecutions[1]!.error).toBe('ENOENT');
  });

  test('second recordModelResponse advances to a new turn', () => {
    const buffer = new TraceBuffer('session-1', store);
    buffer.recordModelResponse({
      text: 'Turn 0', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    buffer.recordModelResponse({
      text: 'Turn 1', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const trace = buffer.finalize('test-model');
    expect(trace.turns.length).toBe(2);
    expect(trace.turns[0]!.turnIndex).toBe(0);
    expect(trace.turns[1]!.turnIndex).toBe(1);
  });

  test('finalize returns complete TraceRun with summary and NDJSON file', async () => {
    const buffer = new TraceBuffer('session-1', store);
    buffer.recordModelResponse({
      text: 'Done', toolCalls: [], usage: { prompt_tokens: 50, completion_tokens: 10 },
    });
    buffer.recordToolExecution({ toolName: 'read', success: true, durationMs: 10 });

    const trace = buffer.finalize('test-model');
    expect(trace.id).toBe(buffer.runId);
    expect(trace.sessionId).toBe('session-1');
    expect(trace.model).toBe('test-model');
    expect(trace.summary.totalTurns).toBe(1);
    expect(trace.summary.totalToolCalls).toBe(1);
    expect(trace.summary.totalErrors).toBe(0);
    expect(trace.summary.outcome).toBe('completed');

    // Verify NDJSON file was written with summary
    const filePath = path.join(TEST_DIR, 'session-1', `${buffer.runId}.jsonl`);
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    const lastLine = JSON.parse(lines[lines.length - 1]!);
    expect(lastLine.type).toBe('summary');
  });

  test('summary correctly counts errors', async () => {
    const buffer = new TraceBuffer('session-1', store);
    buffer.recordModelResponse({
      text: 'Trying', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    buffer.recordToolExecution({ toolName: 'bash', success: false, durationMs: 50, error: 'cmd failed' });

    buffer.recordModelResponse({
      text: 'Retry', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    buffer.recordToolExecution({ toolName: 'bash', success: true, durationMs: 30 });

    const trace = buffer.finalize('test-model');
    expect(trace.summary.totalErrors).toBe(1);
  });

  test('parentRunId is preserved', () => {
    const buffer = new TraceBuffer('session-1', store, 'parent-run-99');
    const trace = buffer.finalize('test-model');
    expect(trace.parentRunId).toBe('parent-run-99');
  });

  test('finalize without any turns produces empty trace', async () => {
    const buffer = new TraceBuffer('session-1', store);
    const trace = buffer.finalize('test-model');
    expect(trace.turns.length).toBe(0);
    expect(trace.summary.totalTurns).toBe(0);
    expect(trace.summary.outcome).toBe('completed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/trace/trace-buffer.test.ts`
Expected: FAIL — "Cannot find module '../../src/trace/trace-buffer'"

- [ ] **Step 3: Write minimal TraceBuffer implementation**

```typescript
import { nanoid } from 'nanoid';
import type { TraceRun, TraceTurn, TraceSummary, TraceStore, TraceEntry } from './types';

export interface ModelResponseRecord {
  thinking?: string;
  text: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  usage: Record<string, number>;
}

export interface ToolExecutionRecord {
  toolName: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

export class TraceBuffer {
  readonly runId: string;
  readonly sessionId: string;
  readonly parentRunId?: string;
  private startTime: number;
  private turns: TraceTurn[] = [];
  private currentTurnIndex = -1;
  private store: TraceStore;
  private modelName = '';

  constructor(sessionId: string, store: TraceStore, parentRunId?: string) {
    this.sessionId = sessionId;
    this.store = store;
    this.parentRunId = parentRunId;
    this.runId = nanoid();
    this.startTime = Date.now();
  }

  recordUserMessage(message: string): void {
    // Stored so the first turn can pick it up
    if (this.turns.length === 0) {
      this.turns.push({ turnIndex: 0, userMessage: message, toolExecutions: [] });
    }
  }

  recordModelResponse(resp: ModelResponseRecord): void {
    this.currentTurnIndex++;
    const turn: TraceTurn = {
      turnIndex: this.currentTurnIndex,
      modelResponse: {
        thinking: resp.thinking,
        text: resp.text,
        toolCalls: resp.toolCalls,
        usage: resp.usage,
      },
      toolExecutions: [],
    };
    this.turns[this.currentTurnIndex] = turn;

    const entry: TraceEntry = {
      type: 'turn',
      turnIndex: this.currentTurnIndex,
      ...turn,
    };
    this.store.appendTurn(this.runId, this.sessionId, entry).catch(() => {});
  }

  recordToolExecution(exec: ToolExecutionRecord): void {
    const turn = this.turns[this.currentTurnIndex];
    if (turn) {
      turn.toolExecutions.push(exec);
    }

    const entry: TraceEntry = { type: 'tool', ...exec };
    this.store.appendTurn(this.runId, this.sessionId, entry).catch(() => {});
  }

  finalize(model: string): TraceRun {
    this.modelName = model;
    const summary = this.computeSummary();
    const trace: TraceRun = {
      id: this.runId,
      sessionId: this.sessionId,
      parentRunId: this.parentRunId,
      startTime: this.startTime,
      endTime: Date.now(),
      model,
      turns: this.turns,
      summary,
    };
    return trace;
  }

  private computeSummary(): TraceSummary {
    let totalToolCalls = 0;
    let totalErrors = 0;
    const totalTokens: Record<string, number> = {};

    for (const turn of this.turns) {
      totalToolCalls += turn.toolExecutions.length;
      for (const exec of turn.toolExecutions) {
        if (!exec.success) totalErrors++;
      }
      if (turn.modelResponse?.usage) {
        for (const [key, value] of Object.entries(turn.modelResponse.usage)) {
          totalTokens[key] = (totalTokens[key] ?? 0) + value;
        }
      }
    }

    return {
      totalTurns: this.turns.filter(t => t.modelResponse).length,
      totalToolCalls,
      totalErrors,
      totalTokens,
      outcome: 'completed',
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/trace/trace-buffer.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/trace/trace-buffer.ts tests/trace/trace-buffer.test.ts
git commit -m "feat: add TraceBuffer with per-run isolation and incremental NDJSON writes"
```

---

### Task 6: Implement NudgeEngine with 3-signal trigger model

**Files:**
- Create: `src/trace/nudge-engine.ts`
- Create: `tests/trace/nudge-engine.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { NudgeEngine } from '../../src/trace/nudge-engine';
import type { TraceRun } from '../../src/trace/types';

const TEST_DIR = path.join(os.tmpdir(), `nudge-test-${Date.now()}`);
const STATE_PATH = path.join(TEST_DIR, 'state.json');

function makeRun(overrides: Partial<TraceRun> = {}): TraceRun {
  return {
    id: 'run-1', sessionId: 's1', startTime: 1000, endTime: 2000, model: 'test',
    turns: [],
    summary: { totalTurns: 0, totalToolCalls: 0, totalErrors: 0, totalTokens: {}, outcome: 'completed' },
    ...overrides,
  };
}

function errorTurn(toolName: string): TraceRun['turns'][number] {
  return {
    turnIndex: 0,
    toolExecutions: [{ toolName, success: false, durationMs: 10, error: 'fail' }],
  };
}

describe('NudgeEngine', () => {
  let engine: NudgeEngine;

  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  test('returns null for a clean short run', () => {
    engine = new NudgeEngine(STATE_PATH);
    const result = engine.tick(makeRun({
      turns: [{ turnIndex: 0, toolExecutions: [{ toolName: 'read', success: true, durationMs: 5 }] }],
      summary: { totalTurns: 1, totalToolCalls: 1, totalErrors: 0, totalTokens: {}, outcome: 'completed' },
    }));
    expect(result).toBeNull();
  });

  test('triggers error_burst signal on >= 2 errors with ratio >= 0.3', () => {
    engine = new NudgeEngine(STATE_PATH);
    const run = makeRun({
      turns: [
        errorTurn('bash'),
        errorTurn('bash'),
        { turnIndex: 1, toolExecutions: [{ toolName: 'read', success: true, durationMs: 5 }] },
      ],
      summary: { totalTurns: 2, totalToolCalls: 3, totalErrors: 2, totalTokens: {}, outcome: 'completed' },
    });
    const result = engine.tick(run);
    expect(result).not.toBeNull();
    expect(result!.trigger).toBe('memory_review');
    expect(result!.reason).toContain('errors');
  });

  test('triggers complex_task signal on >= 5 turns with 0 errors', () => {
    engine = new NudgeEngine(STATE_PATH);
    const turns = Array.from({ length: 5 }, (_, i) => ({
      turnIndex: i,
      toolExecutions: [{ toolName: 'read', success: true, durationMs: 5 }],
    }));
    const run = makeRun({
      turns,
      summary: { totalTurns: 5, totalToolCalls: 5, totalErrors: 0, totalTokens: {}, outcome: 'completed' },
    });
    const result = engine.tick(run);
    expect(result).not.toBeNull();
    expect(result!.trigger).toBe('skill_review');
    expect(result!.reason).toContain('candidate for skill extraction');
  });

  test('error_burst + >=5 turns gives combined_review trigger', () => {
    engine = new NudgeEngine(STATE_PATH);
    const turns = [
      errorTurn('bash'),
      errorTurn('bash'),
      { turnIndex: 1, toolExecutions: [{ toolName: 'read', success: true, durationMs: 5 }] },
      { turnIndex: 2, toolExecutions: [{ toolName: 'read', success: true, durationMs: 5 }] },
      { turnIndex: 3, toolExecutions: [{ toolName: 'read', success: true, durationMs: 5 }] },
      { turnIndex: 4, toolExecutions: [{ toolName: 'read', success: true, durationMs: 5 }] },
    ];
    const run = makeRun({
      turns,
      summary: { totalTurns: 5, totalToolCalls: 6, totalErrors: 2, totalTokens: {}, outcome: 'completed' },
    });
    const result = engine.tick(run);
    expect(result).not.toBeNull();
    expect(result!.trigger).toBe('combined_review');
  });

  test('periodic signal fires after accumulated turns >= reviewInterval', () => {
    engine = new NudgeEngine(STATE_PATH, 3);
    // First run: 2 turns, no trigger
    const r1 = engine.tick(makeRun({
      turns: [{ turnIndex: 0, toolExecutions: [] }, { turnIndex: 1, toolExecutions: [] }],
      summary: { totalTurns: 2, totalToolCalls: 0, totalErrors: 0, totalTokens: {}, outcome: 'completed' },
    }));
    expect(r1).toBeNull();

    // Second run: 2 more turns = 4 accumulated >= 3 interval
    const r2 = engine.tick(makeRun({
      id: 'run-2',
      turns: [{ turnIndex: 0, toolExecutions: [] }, { turnIndex: 1, toolExecutions: [] }],
      summary: { totalTurns: 2, totalToolCalls: 0, totalErrors: 0, totalTokens: {}, outcome: 'completed' },
    }));
    expect(r2).not.toBeNull();
    expect(r2!.trigger).toBe('skill_review');
  });

  test('fingerprint dedup prevents repeated reviews of same error pattern', () => {
    engine = new NudgeEngine(STATE_PATH);
    const run = makeRun({
      turns: [errorTurn('bash'), errorTurn('bash'), { turnIndex: 1, toolExecutions: [{ toolName: 'read', success: true, durationMs: 5 }] }],
      summary: { totalTurns: 2, totalToolCalls: 3, totalErrors: 2, totalTokens: {}, outcome: 'completed' },
    });

    const first = engine.tick(run);
    expect(first).not.toBeNull();

    const second = engine.tick(run);
    expect(second).toBeNull(); // deduped
  });

  test('persist and load state survives roundtrip', async () => {
    engine = new NudgeEngine(STATE_PATH, 5);
    engine.tick(makeRun({
      turns: [{ turnIndex: 0, toolExecutions: [] }, { turnIndex: 1, toolExecutions: [] }],
      summary: { totalTurns: 2, totalToolCalls: 0, totalErrors: 0, totalTokens: {}, outcome: 'completed' },
    }));
    await engine.persist();

    const engine2 = new NudgeEngine(STATE_PATH, 5);
    // 2 turns already accumulated, need 3 more
    const r = engine2.tick(makeRun({
      turns: [{ turnIndex: 0, toolExecutions: [] }, { turnIndex: 1, toolExecutions: [] }, { turnIndex: 2, toolExecutions: [] }],
      summary: { totalTurns: 3, totalToolCalls: 0, totalErrors: 0, totalTokens: {}, outcome: 'completed' },
    }));
    expect(r).not.toBeNull();
  });

  test('MIN_REVIEW_INTERVAL_MS prevents review within 5 minutes', () => {
    engine = new NudgeEngine(STATE_PATH);
    // Force a review
    const run = makeRun({
      turns: [errorTurn('bash'), errorTurn('bash'), { turnIndex: 1, toolExecutions: [{ toolName: 'read', success: true, durationMs: 5 }] }],
      summary: { totalTurns: 2, totalToolCalls: 3, totalErrors: 2, totalTokens: {}, outcome: 'completed' },
    });
    engine.tick(run);

    // Same run immediately — should be null due to time interval
    const second = engine.tick(makeRun({
      id: 'run-3',
      turns: [errorTurn('grep'), errorTurn('grep'), { turnIndex: 1, toolExecutions: [] }],
      summary: { totalTurns: 2, totalToolCalls: 2, totalErrors: 2, totalTokens: {}, outcome: 'completed' },
    }));
    expect(second).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/trace/nudge-engine.test.ts`
Expected: FAIL — "Cannot find module '../../src/trace/nudge-engine'"

- [ ] **Step 3: Write minimal NudgeEngine implementation**

```typescript
import fs from 'fs/promises';
import type { NudgeState, NudgeResult, TraceRun } from './types';

const MIN_REVIEW_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_REVIEW_INTERVAL = 10;

export class NudgeEngine {
  private state: NudgeState;
  private reviewInterval: number;
  private statePath: string;

  constructor(statePath: string, reviewInterval: number = DEFAULT_REVIEW_INTERVAL) {
    this.statePath = statePath;
    this.reviewInterval = reviewInterval;
    this.state = this.defaultState();
    this.loadState();
  }

  tick(trace: TraceRun): NudgeResult | null {
    if (Date.now() - this.state.lastReviewAt < MIN_REVIEW_INTERVAL_MS) {
      return null;
    }

    const errorRatio = trace.summary.totalTurns > 0
      ? trace.summary.totalErrors / trace.summary.totalTurns
      : 0;

    // Signal 1: Error burst
    if (trace.summary.totalErrors >= 2 && errorRatio >= 0.3) {
      const fp = this.buildFingerprint(trace);
      if (!this.isDuplicate('error_burst', fp)) {
        return this.emit('error_burst', trace, fp);
      }
    }

    // Signal 2: Complex task
    if (trace.summary.totalTurns >= 5 && trace.summary.totalErrors === 0) {
      const fp = 'complex:' + this.buildFingerprint(trace);
      if (!this.isDuplicate('complex_task', fp)) {
        return this.emit('complex_task', trace, fp);
      }
    }

    // Signal 3: Periodic
    this.state.turnsSinceReview += trace.summary.totalTurns;
    if (this.state.turnsSinceReview >= this.reviewInterval) {
      this.state.turnsSinceReview = 0;
      const fp = this.buildFingerprint(trace);
      if (!this.isDuplicate('periodic', fp)) {
        return this.emit('periodic', trace, fp);
      }
    }

    return null;
  }

  async persist(): Promise<void> {
    try {
      await fs.mkdir(this.statePath.substring(0, this.statePath.lastIndexOf('/')), { recursive: true });
      await fs.writeFile(this.statePath, JSON.stringify(this.state), 'utf-8');
    } catch {
      // Best-effort persist
    }
  }

  private emit(
    signal: 'error_burst' | 'complex_task' | 'periodic',
    trace: TraceRun,
    fingerprint: string,
  ): NudgeResult {
    this.state.lastReviewAt = Date.now();
    this.recordFingerprint(signal, fingerprint);
    return {
      trigger: this.signalToTrigger(signal, trace),
      traceRunId: trace.id,
      sessionId: trace.sessionId,
      fingerprint: `${signal}:${fingerprint}`,
      reason: this.buildReason(signal, trace),
    };
  }

  private signalToTrigger(
    signal: string,
    trace: TraceRun,
  ): NudgeResult['trigger'] {
    if (signal === 'error_burst' && trace.summary.totalTurns >= 5) {
      return 'combined_review';
    }
    if (signal === 'error_burst') return 'memory_review';
    return 'skill_review';
  }

  // 0 and 2 are loop/index/offset constants — exempt from magic-numbers rule per constitution §I
  private buildReason(signal: string, trace: TraceRun): string {
    const e = trace.summary.totalErrors;
    const t = trace.summary.totalTurns;
    const TWO = 2;
    switch (signal) {
      case 'error_burst':
        return `${e} errors in ${t} turns (error rate: ${Math.round(e / t * 100)}%) — review for failure patterns`;
      case 'complex_task':
        return `${t}-turn task completed successfully — candidate for skill extraction`;
      case 'periodic':
        return `Periodic review after ${this.reviewInterval} accumulated turns`;
    }
  }

  private buildFingerprint(trace: TraceRun): string {
    const errorTools = new Set<string>();
    for (const turn of trace.turns) {
      for (const exec of turn.toolExecutions) {
        if (!exec.success) errorTools.add(exec.toolName);
      }
    }
    return [...errorTools].sort().join(',') || 'no_errors';
  }

  private isDuplicate(signal: string, fp: string): boolean {
    return (this.state.fingerprints[signal] ?? []).includes(fp);
  }

  private recordFingerprint(signal: string, fp: string): void {
    const list = this.state.fingerprints[signal] ?? [];
    list.unshift(fp);
    this.state.fingerprints[signal] = list.slice(0, 5);
  }

  private defaultState(): NudgeState {
    return {
      turnsSinceReview: 0,
      fingerprints: { error_burst: [], complex_task: [], periodic: [] },
      lastReviewAt: 0,
    };
  }

  private loadState(): void {
    try {
      // Synchronous read at construction time — acceptable for a small state file
      const fsSync = require('fs');
      if (fsSync.existsSync(this.statePath)) {
        const raw = fsSync.readFileSync(this.statePath, 'utf-8');
        this.state = { ...this.defaultState(), ...JSON.parse(raw) };
      }
    } catch {
      this.state = this.defaultState();
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/trace/nudge-engine.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/trace/nudge-engine.ts tests/trace/nudge-engine.test.ts
git commit -m "feat: add NudgeEngine with 3-signal trigger model and fingerprint dedup"
```

---

### Task 7: Implement TraceToolMiddleware

**Files:**
- Create: `src/trace/tool-middleware.ts`
- Create: `tests/trace/tool-middleware.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect, vi } from 'bun:test';
import { TraceToolMiddleware } from '../../src/trace/tool-middleware';
import { TraceBuffer } from '../../src/trace/trace-buffer';
import type { ToolCall, AgentContext } from '../../src/types';
import type { ToolContext } from '../../src/agent/tool-dispatch/types';
import { TraceStore } from '../../src/trace/store';
import os from 'os';
import path from 'path';

function makeCtx(overrides: Partial<{ buffer: TraceBuffer | undefined }> = {}): ToolContext {
  const metadata: Record<string, unknown> = {};
  if (overrides.buffer !== undefined) {
    metadata._traceBuffer = overrides.buffer;
  }
  return {
    signal: new AbortController().signal,
    agentContext: { messages: [], config: { tokenLimit: 1000 }, metadata } as AgentContext,
    budget: { remaining: 1000, usageRatio: 0 },
    environment: { agentType: 'main', cwd: '/test' },
    metadata: new Map(),
    sink: { updateTodos: () => {}, _todoUpdates: undefined },
  };
}

describe('TraceToolMiddleware', () => {
  test('records successful tool execution', () => {
    const store = new TraceStore(path.join(os.tmpdir(), `ttm-test-${Date.now()}`));
    const buffer = new TraceBuffer('s1', store);
    buffer.recordModelResponse({ text: '', toolCalls: [], usage: {} });

    const middleware = new TraceToolMiddleware();
    const toolCall: ToolCall = { id: '1', name: 'bash', arguments: {} };
    const ctx = makeCtx({ buffer });

    middleware.handle(toolCall, ctx, async () => 'result');

    const trace = buffer.finalize('test');
    expect(trace.turns[0]!.toolExecutions.length).toBe(1);
    expect(trace.turns[0]!.toolExecutions[0]!.success).toBe(true);
    expect(trace.turns[0]!.toolExecutions[0]!.toolName).toBe('bash');
    expect(trace.turns[0]!.toolExecutions[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('records failed tool execution with error message', async () => {
    const store = new TraceStore(path.join(os.tmpdir(), `ttm-test-${Date.now()}`));
    const buffer = new TraceBuffer('s2', store);
    buffer.recordModelResponse({ text: '', toolCalls: [], usage: {} });

    const middleware = new TraceToolMiddleware();
    const toolCall: ToolCall = { id: '2', name: 'grep', arguments: {} };
    const ctx = makeCtx({ buffer });

    try {
      await middleware.handle(toolCall, ctx, async () => { throw new Error('no matches'); });
    } catch {}

    const trace = buffer.finalize('test');
    expect(trace.turns[0]!.toolExecutions[0]!.success).toBe(false);
    expect(trace.turns[0]!.toolExecutions[0]!.error).toBe('no matches');
  });

  test('re-throws the original error after recording', async () => {
    const store = new TraceStore(path.join(os.tmpdir(), `ttm-test-${Date.now()}`));
    const buffer = new TraceBuffer('s3', store);
    buffer.recordModelResponse({ text: '', toolCalls: [], usage: {} });

    const middleware = new TraceToolMiddleware();
    const ctx = makeCtx({ buffer });
    const err = new Error('original');

    let caught: Error | undefined;
    try {
      await middleware.handle({ id: '3', name: 'bash', arguments: {} }, ctx, async () => { throw err; });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBe(err);
  });

  test('no-op when no trace buffer in context', async () => {
    const middleware = new TraceToolMiddleware();
    const ctx = makeCtx({ buffer: undefined });

    const result = await middleware.handle(
      { id: '4', name: 'read', arguments: {} },
      ctx,
      async () => 'ok',
    );
    expect(result).toBe('ok');
  });

  test('middleware name is "trace"', () => {
    const mw = new TraceToolMiddleware();
    expect(mw.name).toBe('trace');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/trace/tool-middleware.test.ts`
Expected: FAIL — "Cannot find module '../../src/trace/tool-middleware'"

- [ ] **Step 3: Write minimal TraceToolMiddleware implementation**

```typescript
import type { ToolMiddleware } from '../agent/tool-dispatch/middleware';
import type { ToolCall } from '../types';
import type { ToolContext } from '../agent/tool-dispatch/types';
import type { TraceBuffer } from './trace-buffer';

export class TraceToolMiddleware implements ToolMiddleware {
  name = 'trace';

  async handle(
    toolCall: ToolCall,
    ctx: ToolContext,
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    const buffer = ctx.agentContext.metadata._traceBuffer as TraceBuffer | undefined;
    if (!buffer) return next();

    const start = Date.now();
    try {
      const result = await next();
      buffer.recordToolExecution({
        toolName: toolCall.name,
        success: true,
        durationMs: Date.now() - start,
      });
      return result;
    } catch (error) {
      buffer.recordToolExecution({
        toolName: toolCall.name,
        success: false,
        durationMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/trace/tool-middleware.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/trace/tool-middleware.ts tests/trace/tool-middleware.test.ts
git commit -m "feat: add TraceToolMiddleware for recording tool executions"
```

---

### Task 8: Implement TraceAgentMiddleware

**Files:**
- Create: `src/trace/agent-middleware.ts`
- Create: `tests/trace/agent-middleware.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect, beforeEach, afterEach, vi } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { TraceAgentMiddleware } from '../../src/trace/agent-middleware';
import { TraceStore } from '../../src/trace/store';
import { NudgeEngine } from '../../src/trace/nudge-engine';
import { DefaultRedactor } from '../../src/trace/redactor';
import { TraceBuffer } from '../../src/trace/trace-buffer';
import type { AgentContext, AgentConfig, LLMResponse } from '../../src/types';

const TEST_DIR = path.join(os.tmpdir(), `tam-test-${Date.now()}`);

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  const config: AgentConfig = { tokenLimit: 10000 };
  return {
    messages: [
      { role: 'user', content: 'hello world', id: 'msg-1' },
    ],
    config,
    metadata: { sessionId: 'test-session' },
    ...overrides,
  };
}

describe('TraceAgentMiddleware', () => {
  let store: TraceStore;
  let nudgeEngine: NudgeEngine;
  let redactor: DefaultRedactor;
  let middleware: TraceAgentMiddleware;
  let statePath: string;

  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
    statePath = path.join(TEST_DIR, 'nudge-state.json');
    store = new TraceStore(TEST_DIR);
    nudgeEngine = new NudgeEngine(statePath);
    redactor = new DefaultRedactor('default');
    middleware = new TraceAgentMiddleware(store, nudgeEngine, redactor);
  });

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  test('beforeAgentRun creates TraceBuffer and records user message', async () => {
    const ctx = makeContext();
    const next = vi.fn(async () => ctx);

    const result = await middleware.beforeAgentRun!(ctx, next);
    expect(next).toHaveBeenCalled();
    const buffer = result.metadata._traceBuffer as TraceBuffer;
    expect(buffer).toBeDefined();
    expect(buffer.runId).toBeString();
  });

  test('beforeAddResponse records model response with redacted text', async () => {
    const ctx = makeContext();
    const nextCtx = await middleware.beforeAgentRun!(ctx, vi.fn(async () => ctx));

    const response: LLMResponse = {
      content: 'API key is sk-abc123',
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      model: 'test-model',
      tool_calls: [{ id: 'tc1', name: 'read', arguments: { file: '/secret/config.yml' } }],
    };

    const ctxWithResponse = { ...nextCtx, response };
    const next = vi.fn(async () => ctxWithResponse);

    const result = await middleware.beforeAddResponse!(ctxWithResponse, next);
    expect(next).toHaveBeenCalled();
    const buffer = result.metadata._traceBuffer as TraceBuffer;
    const trace = buffer.finalize('test-model');
    expect(trace.turns.length).toBe(1);
    expect(trace.turns[0]!.modelResponse!.text).not.toContain('sk-abc123');
    // Note: thinking is undefined — response.blocks are set AFTER beforeAddResponse
    // (agent-loop.ts:384), so thinking data is not available at this hook point.
    expect(trace.turns[0]!.modelResponse!.thinking).toBeUndefined();
  });

  test('afterAgentRun finalizes trace and calls nudgeEngine.tick', async () => {
    const ctx = makeContext();
    const ctxWithBuffer = await middleware.beforeAgentRun!(ctx, vi.fn(async () => ctx));
    const buffer = ctxWithBuffer.metadata._traceBuffer as TraceBuffer;
    buffer.recordModelResponse({ text: 'done', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });

    const next = vi.fn(async () => ctxWithBuffer);

    // Spy on nudgeEngine.tick
    const tickSpy = vi.spyOn(nudgeEngine, 'tick');

    const result = await middleware.afterAgentRun!(ctxWithBuffer, next);
    expect(next).toHaveBeenCalled();

    // Wait for setImmediate
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(tickSpy).toHaveBeenCalled();
    tickSpy.mockRestore();
  });

  test('no-op when no TraceBuffer in context', async () => {
    const ctx = makeContext();
    const next = vi.fn(async () => ctx);

    // beforeAddResponse without buffer
    const result = await middleware.beforeAddResponse!(ctx, next);
    expect(result).toBe(ctx);

    // afterAgentRun without buffer
    const result2 = await middleware.afterAgentRun!(ctx, next);
    expect(result2).toBe(ctx);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/trace/agent-middleware.test.ts`
Expected: FAIL — "Cannot find module '../../src/trace/agent-middleware'"

- [ ] **Step 3: Write minimal TraceAgentMiddleware implementation**

```typescript
import type { Middleware, AgentMiddleware, AgentContext } from '../types';
import { TraceBuffer } from './trace-buffer';
import type { TraceStore, TraceRedactor } from './types';
import type { NudgeEngine } from './nudge-engine';
import { debugLog } from '../utils/debug';

export class TraceAgentMiddleware implements AgentMiddleware {
  constructor(
    private store: TraceStore,
    private nudgeEngine: NudgeEngine,
    private redactor: TraceRedactor,
  ) {}

  beforeAgentRun: Middleware = async (context, next) => {
    const parentRunId = context.metadata._parentTraceRunId as string | undefined;
    const buffer = new TraceBuffer(this.sessionId(context), this.store, parentRunId);
    context.metadata._traceBuffer = buffer;

    const lastUserMsg = [...context.messages].reverse().find(m => m.role === 'user');
    if (lastUserMsg) {
      buffer.recordUserMessage(lastUserMsg.content);
    }

    return next();
  };

  beforeAddResponse: Middleware = async (context, next) => {
    const ctx = await next();
    const buffer = ctx.metadata._traceBuffer as TraceBuffer | undefined;
    if (!buffer || !ctx.response) return ctx;

    // Note: thinking is unavailable here — response.blocks (including thinking)
    // are set AFTER beforeAddResponse completes (agent-loop.ts:384).
    buffer.recordModelResponse({
      text: this.redactor.redactText(ctx.response.content),
      toolCalls: (ctx.response.tool_calls ?? []).map(tc => ({
        name: tc.name,
        arguments: this.redactor.redactToolArguments(tc.name, tc.arguments),
      })),
      usage: ctx.response.usage as Record<string, number>,
    });

    return ctx;
  };

  afterAgentRun: Middleware = async (context, next) => {
    const ctx = await next();
    const buffer = ctx.metadata._traceBuffer as TraceBuffer | undefined;
    if (!buffer) return ctx;

    const model = ctx.response?.model ?? 'unknown';
    const trace = buffer.finalize(model);

    setImmediate(async () => {
      try {
        await this.store.finalize(trace);
        const nudgeResult = this.nudgeEngine.tick(trace);
        if (nudgeResult) {
          debugLog(`[trace] Nudge triggered: ${nudgeResult.reason}`);
          await this.nudgeEngine.persist();
        }
      } catch (err) {
        debugLog(`[trace] Finalize failed: ${err}`);
      }
    });

    return ctx;
  };

  private sessionId(context: AgentContext): string {
    return (context.metadata.sessionId as string) || 'unknown';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/trace/agent-middleware.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/trace/agent-middleware.ts tests/trace/agent-middleware.test.ts
git commit -m "feat: add TraceAgentMiddleware with beforeAgentRun, beforeAddResponse, afterAgentRun hooks"
```

---

### Task 9: Create factory and index

**Files:**
- Create: `src/trace/index.ts`

- [ ] **Step 1: Write the factory + index**

```typescript
import { TraceAgentMiddleware } from './agent-middleware';
import { TraceToolMiddleware } from './tool-middleware';
import { TraceStore } from './store';
import { NudgeEngine } from './nudge-engine';
import { DefaultRedactor } from './redactor';
import type { TraceRedactor, TraceStore as ITraceStore, NudgeResult, NudgeState, TraceRun, TraceTurn, TraceSummary, TraceEntry } from './types';
import { TraceBuffer } from './trace-buffer';
import type { ModelResponseRecord, ToolExecutionRecord } from './trace-buffer';
import os from 'os';
import path from 'path';

const DEFAULT_TRACE_DIR = path.join(os.homedir(), '.my-agent', 'traces');
const DEFAULT_STATE_PATH = path.join(os.homedir(), '.my-agent', 'trace-state.json');

export interface TraceMiddlewareSet {
  agentMiddleware: TraceAgentMiddleware;
  toolMiddleware: TraceToolMiddleware;
  store: ITraceStore;
  nudgeEngine: NudgeEngine;
  redactor: TraceRedactor;
}

export function createTraceMiddleware(options: {
  store?: ITraceStore;
  redactor?: TraceRedactor;
  reviewInterval?: number;
  baseDir?: string;
} = {}): TraceMiddlewareSet {
  const baseDir = options.baseDir ?? DEFAULT_TRACE_DIR;
  const store = options.store ?? new TraceStore(baseDir);
  const redactor = options.redactor ?? new DefaultRedactor('default');
  const statePath = path.join(baseDir, '..', 'trace-state.json');
  const nudgeEngine = new NudgeEngine(
    options.baseDir ? path.join(options.baseDir, '..', 'trace-state.json') : DEFAULT_STATE_PATH,
    options.reviewInterval,
  );
  const agentMiddleware = new TraceAgentMiddleware(store, nudgeEngine, redactor);
  const toolMiddleware = new TraceToolMiddleware();

  return { agentMiddleware, toolMiddleware, store, nudgeEngine, redactor };
}

// Re-export types for external consumers
export type {
  TraceRun, TraceTurn, TraceSummary, TraceEntry,
  TraceRedactor, NudgeResult, NudgeState,
  ModelResponseRecord, ToolExecutionRecord,
};

export { TraceBuffer, TraceStore, NudgeEngine, DefaultRedactor, TraceAgentMiddleware, TraceToolMiddleware };
```

- [ ] **Step 2: Run type check**

Run: `bun run tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/trace/index.ts
git commit -m "feat: add createTraceMiddleware factory and public trace API"
```

---

### Task 10: Add `initialMetadata` to ContextManager

**Files:**
- Modify: `src/agent/context.ts` (add `initialMetadata` to constructor + `getContext`)
- Create: `tests/trace/context-metadata.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from 'bun:test';
import { ContextManager } from '../../src/agent/context';

describe('ContextManager initialMetadata', () => {
  test('initialMetadata is merged into getContext metadata', () => {
    const cm = new ContextManager({
      tokenLimit: 10000,
      initialMetadata: { _parentTraceRunId: 'parent-123', custom: 'value' },
    });

    const ctx = cm.getContext({ tokenLimit: 10000 });
    expect(ctx.metadata._parentTraceRunId).toBe('parent-123');
    expect(ctx.metadata.custom).toBe('value');
  });

  test('getContext todo metadata still works with initialMetadata', () => {
    const cm = new ContextManager({
      tokenLimit: 10000,
      initialMetadata: { _parentTraceRunId: 'parent-456' },
    });

    const ctx = cm.getContext({ tokenLimit: 10000 });
    expect(ctx.metadata.todo).toBeDefined();
    expect(ctx.metadata._parentTraceRunId).toBe('parent-456');
  });

  test('no initialMetadata defaults to empty', () => {
    const cm = new ContextManager({ tokenLimit: 10000 });
    const ctx = cm.getContext({ tokenLimit: 10000 });
    expect(ctx.metadata.todo).toBeDefined();
    expect(ctx.metadata._parentTraceRunId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/trace/context-metadata.test.ts`
Expected: FAIL — initialMetadata not accepted by constructor

- [ ] **Step 3: Modify ContextManager constructor and getContext**

In `src/agent/context.ts`:

Add `initialMetadata` to `ContextManagerConfig`:

```typescript
export interface ContextManagerConfig {
  tokenLimit?: number;
  compressionStrategy?: CompressionStrategy;
  defaultSystemPrompt?: string;
  initialMetadata?: Record<string, unknown>;
}
```

Add the field in the constructor body (after `this.currentSystemPrompt` assignment):

```typescript
private initialMetadata: Record<string, unknown>;

constructor(config: ContextManagerConfig = {}) {
  // ... existing code ...
  this.initialMetadata = config.initialMetadata ?? {};
  // ... rest of existing code ...
}
```

Modify `getContext` to merge initialMetadata (line 201-217):

```typescript
getContext(config: AgentConfig): AgentContext {
  const result: AgentContext = {
    messages: [...this.messages],
    config,
    metadata: {
      ...this.initialMetadata,
      todo: {
        todoStore: [...this.todoStore],
        stepsSinceLastWrite: this.todoStepsSinceLastWrite,
        stepsSinceLastReminder: this.todoStepsSinceLastReminder,
      },
    },
  };
  if (this.currentSystemPrompt) {
    result.systemPrompt = this.currentSystemPrompt;
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/trace/context-metadata.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent/context.ts tests/trace/context-metadata.test.ts
git commit -m "feat: add initialMetadata to ContextManager for trace parentRunId propagation"
```

---

### Task 11: Propagate `parentRunId` through SubAgentTool

**Files:**
- Modify: `src/agent/sub-agent-tool.ts`
- Modify: `tests/trace/sub-agent-isolation.test.ts` (add parentRunId linkage test)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect, vi } from 'bun:test';
import { SubAgentTool } from '../../src/agent/sub-agent-tool';
import { ContextManager } from '../../src/agent/context';
import { TraceBuffer } from '../../src/trace/trace-buffer';
import { TraceStore } from '../../src/trace/store';
import { ToolRegistry } from '../../src/agent/tool-registry';
import type { Provider, AgentConfig } from '../../src/types';
import { ScriptedProvider } from '../integration/agent-loop-events.test.ts';
import { createTestCtx } from '../agent/tool-dispatch/test-helpers';
import os from 'os';
import path from 'path';

const mockProvider: Provider = {
  registerTools: () => {},
  invoke: async () => { throw new Error('not implemented'); },
  stream: async function*() { yield { done: true }; },
  getModelName: () => 'test',
};

const mockConfig: AgentConfig = { tokenLimit: 50000 };

describe('Sub-agent trace parentRunId linkage', () => {
  test('sub-agent ContextManager receives _parentTraceRunId from parent buffer', async () => {
    const mainRegistry = new ToolRegistry();
    const store = new TraceStore(path.join(os.tmpdir(), `sub-trace-test-${Date.now()}`));
    const parentBuffer = new TraceBuffer('parent-session', store);
    const parentRunId = parentBuffer.runId;

    const tool = new SubAgentTool({
      mainProvider: mockProvider,
      mainToolRegistry: mainRegistry,
      mainAgentConfig: mockConfig,
    });

    const contextSpy = vi.spyOn(ContextManager.prototype, 'getContext');

    const ctx = createTestCtx();
    // Inject parent trace buffer into tool context metadata
    (ctx.agentContext as Record<string, unknown>).metadata = {
      ...ctx.agentContext.metadata,
      _traceBuffer: parentBuffer,
    };

    try {
      await tool.execute({ goal: 'test', deliverable: 'summary' }, ctx);
    } catch {}

    expect(contextSpy).toHaveBeenCalled();
    const subCtx = contextSpy.mock.results[0]?.value;
    if (subCtx) {
      expect(subCtx.metadata._parentTraceRunId).toBe(parentRunId);
    }

    contextSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/trace/sub-agent-isolation.test.ts`
Expected: FAIL — _parentTraceRunId is undefined in sub-context

- [ ] **Step 3: Modify SubAgentTool.execute() to propagate parentRunId**

In `src/agent/sub-agent-tool.ts`, modify the ContextManager creation (around line 280-283):

```typescript
// After the systemPrompt build, before new ContextManager():
import { TraceBuffer } from '../trace/trace-buffer';

// Inside execute(), replace this block:
//   const subContextManager = new ContextManager({
//     tokenLimit,
//     defaultSystemPrompt: systemPrompt,
//   });

const parentTraceRunId =
  (ctx.agentContext.metadata._traceBuffer as TraceBuffer | undefined)?.runId;

const subContextManager = new ContextManager({
  tokenLimit,
  defaultSystemPrompt: systemPrompt,
  ...(parentTraceRunId ? { initialMetadata: { _parentTraceRunId: parentTraceRunId } } : {}),
});
```

Also add the import at the top of the file:

```typescript
import { TraceBuffer } from '../trace/trace-buffer';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/trace/sub-agent-isolation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/sub-agent-tool.ts tests/trace/sub-agent-isolation.test.ts
git commit -m "feat: propagate parentTraceRunId to sub-agent ContextManager"
```

---

### Task 12: Wire trace middleware into runtime.ts

**Files:**
- Modify: `src/runtime.ts`

- [ ] **Step 1: Review runtime.ts hooks assembly**

The hooks object at lines 140-144 currently only has `beforeAgentRun`, `beforeModel`, `afterAgentRun`. We need to add `beforeAddResponse`. We also need to add the trace tool middleware and agent middleware hooks.

- [ ] **Step 2: Modify runtime.ts**

Add import at the top:

```typescript
import { createTraceMiddleware } from './trace';
import type { TraceSettings } from './config/types';
```

Expand the hooks type to include `beforeAddResponse`:

```typescript
const hooks: Required<Pick<AgentHooks, 'beforeAgentRun' | 'beforeModel' | 'beforeAddResponse' | 'afterAgentRun'>> = {
  beforeAgentRun: [],
  beforeModel: [],
  beforeAddResponse: [],
  afterAgentRun: [],
};
```

After the MCP assembly block (line 167), add trace middleware setup:

```typescript
// Trace
let traceNudgeEngine: ReturnType<typeof createTraceMiddleware>['nudgeEngine'] | undefined;
const traceEnabled = settings.trace?.enabled !== false;
if (traceEnabled) {
  const traceMw = createTraceMiddleware({
    reviewInterval: settings.trace?.nudge?.reviewInterval,
  });
  hooks.beforeAgentRun.unshift(traceMw.agentMiddleware.beforeAgentRun);
  hooks.beforeAddResponse.push(traceMw.agentMiddleware.beforeAddResponse);
  hooks.afterAgentRun.push(traceMw.agentMiddleware.afterAgentRun);
  toolMiddlewares.push(traceMw.toolMiddleware);
  traceNudgeEngine = traceMw.nudgeEngine;
}
```

Note: `beforeAgentRun` uses `unshift` so it runs FIRST (creates buffer before any other middleware uses it). `afterAgentRun` uses `push` so it runs LAST (finalizes after all other teardown). `toolMiddlewares.push` adds trace as the innermost onion layer.

- [ ] **Step 3: Run type check and existing tests**

Run: `bun run tsc --noEmit`
Expected: PASS

Run: `bun test tests/trace/`
Expected: all trace tests PASS

Run: `bun test tests/runtime.test.ts`
Expected: PASS (no regression)

- [ ] **Step 4: Commit**

```bash
git add src/runtime.ts
git commit -m "feat: wire trace middleware into createAgentRuntime"
```

---

### Task 13: Integration tests — crash recovery and end-to-end

**Files:**
- Create: `tests/trace/crash-recovery.test.ts`

- [ ] **Step 1: Write crash recovery test**

```typescript
import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { TraceStore } from '../../src/trace/store';
import { TraceBuffer } from '../../src/trace/trace-buffer';
import type { TraceRun } from '../../src/trace/types';

const TEST_DIR = path.join(os.tmpdir(), `crash-test-${Date.now()}`);

describe('Crash recovery', () => {
  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  test('partial NDJSON file (missing summary) is recoverable', async () => {
    const store = new TraceStore(TEST_DIR);
    const buffer = new TraceBuffer('session-1', store);
    buffer.recordModelResponse({
      text: 'turn 0',
      toolCalls: [{ name: 'read', arguments: {} }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    buffer.recordToolExecution({ toolName: 'read', success: true, durationMs: 10 });

    buffer.recordModelResponse({
      text: 'turn 1',
      toolCalls: [{ name: 'bash', arguments: {} }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    });

    // Simulate crash: don't call finalize, just verify the NDJSON file exists
    // and contains the turn/tool lines without summary
    const filePath = path.join(TEST_DIR, 'session-1', `${buffer.runId}.jsonl`);
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');

    // Should have: turn0, tool_read, turn1 (no summary)
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0]!).type).toBe('turn');
    expect(JSON.parse(lines[1]!).type).toBe('tool');
    expect(JSON.parse(lines[2]!).type).toBe('turn');

    // get() returns null because no summary
    const result = await store.get(buffer.runId, 'session-1');
    expect(result).toBeNull();
  });

  test('completed trace with summary is fully recoverable', async () => {
    const store = new TraceStore(TEST_DIR);
    const buffer = new TraceBuffer('session-1', store);
    buffer.recordModelResponse({
      text: 'done',
      toolCalls: [],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });

    const trace = buffer.finalize('test-model');
    await store.finalize(trace);

    const recovered = await store.get(buffer.runId, 'session-1');
    expect(recovered).not.toBeNull();
    expect(recovered!.turns.length).toBe(1);
    expect(recovered!.summary.outcome).toBe('completed');
  });

  test('concurrent sub-agent traces are independent', async () => {
    const store = new TraceStore(TEST_DIR);

    const parent = new TraceBuffer('session-1', store);
    parent.recordModelResponse({
      text: 'spawning sub-agents',
      toolCalls: [{ name: 'sub_agent', arguments: { goal: 'task-a' } }],
      usage: { prompt_tokens: 30, completion_tokens: 15 },
    });

    const childA = new TraceBuffer('session-1', store, parent.runId);
    childA.recordModelResponse({
      text: 'sub-agent A work',
      toolCalls: [{ name: 'read', arguments: {} }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const childB = new TraceBuffer('session-1', store, parent.runId);
    childB.recordModelResponse({
      text: 'sub-agent B work',
      toolCalls: [{ name: 'grep', arguments: {} }],
      usage: { prompt_tokens: 8, completion_tokens: 4 },
    });

    // All three buffers have different runIds
    expect(parent.runId).not.toBe(childA.runId);
    expect(parent.runId).not.toBe(childB.runId);
    expect(childA.runId).not.toBe(childB.runId);

    // Child buffers link to parent
    expect(childA.parentRunId).toBe(parent.runId);
    expect(childB.parentRunId).toBe(parent.runId);

    // Parent buffer has no parentRunId
    expect(parent.parentRunId).toBeUndefined();

    // Finalize and verify independence
    await store.finalize(parent.finalize('test'));
    await store.finalize(childA.finalize('test'));
    await store.finalize(childB.finalize('test'));

    const parentTrace = await store.get(parent.runId, 'session-1');
    const childATrace = await store.get(childA.runId, 'session-1');
    const childBTrace = await store.get(childB.runId, 'session-1');

    expect(parentTrace!.turns[0]!.toolExecutions.length).toBe(0);
    expect(childATrace!.turns.length).toBe(1);
    expect(childBTrace!.turns.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test tests/trace/crash-recovery.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 3: Run all trace tests together**

Run: `bun test tests/trace/`
Expected: all tests PASS

- [ ] **Step 4: Run full test suite to check for regressions**

Run: `bun test`
Expected: PASS (no regressions)

- [ ] **Step 5: Commit**

```bash
git add tests/trace/crash-recovery.test.ts
git commit -m "test: add crash recovery and sub-agent isolation integration tests"
```

---

## Architecture Compliance Checklist (Constitution §A–I)

- **§A** ✅ — Wiring via `createAgentRuntime()`, no direct instantiation in `bin/*`
- **§B** ✅ — No `any` types. `_traceBuffer` accessed via `as TraceBuffer | undefined`
- **§C** ✅ — Uses 3 of 6 existing hook points, no new hooks
- **§D** ✅ — ToolDispatcher unchanged, TraceToolMiddleware is a consumer
- **§E** ✅ — No new `syncTodoFromContext` call sites
- **§F** ✅ — All exports used, no dead code
- **§G** ✅ — All new files < 150 lines, all functions < 50 lines
- **§H** ✅ — 8 test files covering all new public APIs
- **§I** ✅ — `debugLog` used instead of `console.log`, no `@ts-ignore`
