# Lobster Plan 02: Agent Core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 AgentCore 单例类，托管所有重资源，消除模块级单例，建立类型化 EventBus 和 RunContext，实现 bootstrap 模块化初始化

**Architecture:** Profile-isolated singleton, thin runtime wrapper, strict dependency order, event-driven architecture with typed events

**Tech Stack:** TypeScript, Zod, Bun, EventEmitter

**Depends On:** Plan 01 完成 (Shared utilities & Config system)

---

## 文件结构清单

| 文件 | 操作 | 描述 |
|---|---|---|
| `src/core/types.ts` | 新增 | Core 类型定义 (RunContext, Events) |
| `src/core/runtime/event-bus.ts` | 新增 | 类型化事件总线 |
| `src/core/runtime/run-context.ts` | 新增 | 跨子系统上下文定义 |
| `src/core/bootstrap/provider.bootstrap.ts` | 新增 | Provider 初始化器 |
| `src/core/bootstrap/mcp.bootstrap.ts` | 新增 | MCP 管理器初始化器 |
| `src/core/bootstrap/memory.bootstrap.ts` | 新增 | Memory 存储初始化器 |
| `src/core/bootstrap/skills.bootstrap.ts` | 新增 | Skills 加载器初始化器 |
| `src/core/bootstrap/tools.bootstrap.ts` | 新增 | ToolRegistry 初始化器 |
| `src/core/bootstrap/trace.bootstrap.ts` | 新增 | Trace writer 初始化器 |
| `src/core/bootstrap/identity.bootstrap.ts` | 新增 | Identity 存储初始化器 |
| `src/core/bootstrap/index.ts` | 新增 | 统一初始化入口 |
| `src/core/agent-core.ts` | 新增 | AgentCore 主类 |
| `src/core/index.ts` | 新增 | Core 模块导出 |
| `tests/core/event-bus.test.ts` | 新增 | EventBus 测试 |
| `tests/core/agent-core.test.ts` | 新增 | AgentCore 集成测试 |

---

## Task 1: Core 类型定义

**Files:**
- Create: `src/core/types.ts`
- Create: `src/core/runtime/run-context.ts`

- [ ] **Step 1: 创建 RunContext 类型定义**

```typescript
// src/core/runtime/run-context.ts
import type { Ulid } from '../../shared';

export type RunContext = {
  sessionId: Ulid;
  profileId: string;
  frontendId?: string;
  turnId: Ulid;
  abortSignal: AbortSignal;
};
```

- [ ] **Step 2: 创建 Events 类型定义**

```typescript
// src/core/types.ts
import type { Ulid } from '../shared';

export type Tokens = {
  input: number;
  output: number;
  total: number;
};

export type CoreEvents = {
  'turn:started': { sessionId: Ulid; turnId: Ulid };
  'turn:completed': { sessionId: Ulid; turnId: Ulid; tokens: Tokens };
  'turn:failed': { sessionId: Ulid; turnId: Ulid; error: Error };
  'session:created': { sessionId: Ulid };
  'session:closed': { sessionId: Ulid };
  'identity:changed': { digest: string; effectiveFrom: 'next-turn' };
  'skills:reloaded': { added: string[]; removed: string[]; updated: string[] };
  'mcp:reloaded': { reconnected: string[]; failed: string[] };
  'evolution:progress': { phase: string; pendingSkills: number };
  'evolution:skillProposed': { id: Ulid; name: string; summary: string };
  'system:warn': { code: string; message: string };
};

export type CoreEventType = keyof CoreEvents;
```

- [ ] **Step 3: Run TypeScript check**

Run: `bun run tsc --noEmit`
Expected: No errors for new files

---

## Task 2: EventBus 实现

**Files:**
- Create: `src/core/runtime/event-bus.ts`
- Create: `tests/core/event-bus.test.ts`

- [ ] **Step 1: 编写失败测试**

```typescript
// tests/core/event-bus.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { EventBus } from '../../src/core/runtime/event-bus';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('should emit and receive events', () => {
    let received = false;
    bus.on('system:warn', (payload) => {
      expect(payload.code).toBe('TEST-001');
      expect(payload.message).toBe('test warning');
      received = true;
    });
    bus.emit('system:warn', { code: 'TEST-001', message: 'test warning' });
    expect(received).toBe(true);
  });

  it('should allow unsubscribing', () => {
    let count = 0;
    const unsubscribe = bus.on('system:warn', () => count++);
    bus.emit('system:warn', { code: 'T1', message: 'm1' });
    unsubscribe();
    bus.emit('system:warn', { code: 'T2', message: 'm2' });
    expect(count).toBe(1);
  });

  it('should allow multiple handlers', () => {
    let count1 = 0;
    let count2 = 0;
    bus.on('system:warn', () => count1++);
    bus.on('system:warn', () => count2++);
    bus.emit('system:warn', { code: 'T', message: 'm' });
    expect(count1).toBe(1);
    expect(count2).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/core/event-bus.test.ts`
Expected: FAIL with "EventBus not defined"

- [ ] **Step 3: 实现 EventBus**

```typescript
// src/core/runtime/event-bus.ts
import type { CoreEvents, CoreEventType } from '../types';

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers: Map<CoreEventType, Set<Handler<any>>> = new Map();

  emit<K extends CoreEventType>(type: K, payload: CoreEvents[K]): void {
    const handlers = this.handlers.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(payload);
        } catch (e) {
          // Handler errors don't break other handlers
          console.error('Event handler error:', e);
        }
      }
    }
  }

  on<K extends CoreEventType>(type: K, handler: Handler<CoreEvents[K]>): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    const handlers = this.handlers.get(type)!;
    handlers.add(handler);
    return () => this.off(type, handler);
  }

  off<K extends CoreEventType>(type: K, handler: Handler<CoreEvents[K]>): void {
    const handlers = this.handlers.get(type);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  destroy(): void {
    this.handlers.clear();
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test tests/core/event-bus.test.ts`
Expected: 3 passing tests

---

## Task 3: Bootstrap 模块 - Identity & Trace

**Files:**
- Create: `src/core/bootstrap/identity.bootstrap.ts`
- Create: `src/core/bootstrap/trace.bootstrap.ts`

- [ ] **Step 1: 创建 Identity bootstrap**

```typescript
// src/core/bootstrap/identity.bootstrap.ts
import type { ResolvedConfig } from '../../config';

// Placeholder - IdentityStore from original codebase
export class IdentityStore {
  readonly profileId: string;
  private digest: string = '';

  constructor(profileId: string) {
    this.profileId = profileId;
  }

  getIdentityDigest(): string {
    return this.digest || `identity:${this.profileId}`;
  }

  async setIdentity(config: Record<string, any>): Promise<void> {
    this.digest = `digest:${Date.now()}`;
  }
}

export async function bootstrapIdentity(
  profileId: string,
  config: ResolvedConfig
): Promise<IdentityStore> {
  const store = new IdentityStore(profileId);
  return store;
}
```

- [ ] **Step 2: 创建 Trace bootstrap**

```typescript
// src/core/bootstrap/trace.bootstrap.ts
import type { ResolvedConfig } from '../../config';
import { generateULID } from '../../shared';

// Placeholder - TraceWriter from original codebase
export class TraceWriter {
  readonly profileId: string;
  private enabled: boolean = true;

  constructor(profileId: string, config: ResolvedConfig) {
    this.profileId = profileId;
  }

  async write(sessionId: string, data: any): Promise<void> {
    if (!this.enabled) return;
  }

  async flush(): Promise<void> {}
}

export async function bootstrapTrace(
  profileId: string,
  config: ResolvedConfig
): Promise<TraceWriter> {
  const writer = new TraceWriter(profileId, config);
  return writer;
}
```

- [ ] **Step 3: Run TypeScript check**

Run: `bun run tsc --noEmit`
Expected: No errors

---

## Task 4: Bootstrap 模块 - Provider, Memory, MCP

**Files:**
- Create: `src/core/bootstrap/provider.bootstrap.ts`
- Create: `src/core/bootstrap/memory.bootstrap.ts`
- Create: `src/core/bootstrap/mcp.bootstrap.ts`

- [ ] **Step 1: 创建 Provider bootstrap**

```typescript
// src/core/bootstrap/provider.bootstrap.ts
import type { ResolvedConfig } from '../../config';

// Placeholder - Provider from original codebase
export interface Provider {
  readonly name: string;
  readonly model: string;
}

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  readonly model: string;

  constructor(config: ResolvedConfig) {
    this.model = config.provider.model;
  }
}

export async function bootstrapProvider(
  config: ResolvedConfig
): Promise<Provider> {
  const provider = new AnthropicProvider(config);
  return provider;
}
```

- [ ] **Step 2: 创建 Memory bootstrap**

```typescript
// src/core/bootstrap/memory.bootstrap.ts
import type { ResolvedConfig } from '../../config';

// Placeholder - MemoryStore from original codebase
export class MemoryStore {
  readonly profileId: string;

  constructor(profileId: string, config: ResolvedConfig) {
    this.profileId = profileId;
  }

  async search(query: string): Promise<any[]> {
    return [];
  }

  async add(memory: any): Promise<void> {}
}

export async function bootstrapMemory(
  profileId: string,
  config: ResolvedConfig
): Promise<MemoryStore> {
  const store = new MemoryStore(profileId, config);
  return store;
}
```

- [ ] **Step 3: 创建 MCP bootstrap**

```typescript
// src/core/bootstrap/mcp.bootstrap.ts
import type { ResolvedConfig } from '../../config';

// Placeholder - McpManager from original codebase
export class McpManager {
  readonly profileId: string;
  private servers: Map<string, any> = new Map();

  constructor(profileId: string, config: ResolvedConfig) {
    this.profileId = profileId;
  }

  async connectAll(): Promise<{ reconnected: string[]; failed: string[] }> {
    return { reconnected: [], failed: [] };
  }

  async disconnectAll(): Promise<void> {}
}

export async function bootstrapMcp(
  profileId: string,
  config: ResolvedConfig
): Promise<McpManager> {
  const manager = new McpManager(profileId, config);
  await manager.connectAll();
  return manager;
}
```

- [ ] **Step 4: Run TypeScript check**

Run: `bun run tsc --noEmit`
Expected: No errors

---

## Task 5: Bootstrap 模块 - Skills, Tools, Permission

**Files:**
- Create: `src/core/bootstrap/skills.bootstrap.ts`
- Create: `src/core/bootstrap/tools.bootstrap.ts`

- [ ] **Step 1: 创建 Skills bootstrap**

```typescript
// src/core/bootstrap/skills.bootstrap.ts
import type { ResolvedConfig } from '../../config';

// Placeholder - SkillLoader from original codebase
export class SkillLoader {
  readonly profileId: string;
  private skills: Map<string, any> = new Map();

  constructor(profileId: string, config: ResolvedConfig) {
    this.profileId = profileId;
  }

  async loadAll(): Promise<{ added: string[]; removed: string[]; updated: string[] }> {
    return { added: [], removed: [], updated: [] };
  }
}

export async function bootstrapSkills(
  profileId: string,
  config: ResolvedConfig
): Promise<SkillLoader> {
  const loader = new SkillLoader(profileId, config);
  await loader.loadAll();
  return loader;
}
```

- [ ] **Step 2: 创建 Tools bootstrap (PermissionManager + ToolRegistry)**

```typescript
// src/core/bootstrap/tools.bootstrap.ts
import type { ResolvedConfig } from '../../config';
import type { SkillLoader } from './skills.bootstrap';
import type { McpManager } from './mcp.bootstrap';

// Placeholder - PermissionManager from original codebase
export class PermissionManager {
  readonly profileId: string;
  private allowedTools: Set<string> = new Set();

  constructor(profileId: string) {
    this.profileId = profileId;
  }

  isAllowed(toolName: string): boolean {
    return this.allowedTools.has(toolName) || true;
  }

  allow(toolName: string): void {
    this.allowedTools.add(toolName);
  }
}

// Placeholder - ToolRegistry from original codebase
export class ToolRegistry {
  readonly profileId: string;
  private tools: Map<string, any> = new Map();

  constructor(
    profileId: string,
    private skillLoader: SkillLoader,
    private mcpManager: McpManager
  ) {
    this.profileId = profileId;
  }

  getTool(name: string): any | undefined {
    return this.tools.get(name);
  }

  listTools(): string[] {
    return Array.from(this.tools.keys());
  }
}

export async function bootstrapTools(
  profileId: string,
  config: ResolvedConfig,
  skillLoader: SkillLoader,
  mcpManager: McpManager
): Promise<{ tools: ToolRegistry; permission: PermissionManager }> {
  const permission = new PermissionManager(profileId);
  const tools = new ToolRegistry(profileId, skillLoader, mcpManager);
  return { tools, permission };
}
```

- [ ] **Step 3: Run TypeScript check**

Run: `bun run tsc --noEmit`
Expected: No errors

---

## Task 6: Bootstrap 统一入口

**Files:**
- Create: `src/core/bootstrap/index.ts`

- [ ] **Step 1: 创建 bootstrapAll 入口**

```typescript
// src/core/bootstrap/index.ts
import type { ResolvedConfig } from '../../config';
import { bootstrapIdentity, IdentityStore } from './identity.bootstrap';
import { bootstrapTrace, TraceWriter } from './trace.bootstrap';
import { bootstrapProvider, Provider } from './provider.bootstrap';
import { bootstrapMemory, MemoryStore } from './memory.bootstrap';
import { bootstrapMcp, McpManager } from './mcp.bootstrap';
import { bootstrapSkills, SkillLoader } from './skills.bootstrap';
import { bootstrapTools, ToolRegistry, PermissionManager } from './tools.bootstrap';

export type BootstrapResult = {
  identity: IdentityStore;
  trace: TraceWriter;
  provider: Provider;
  memory: MemoryStore;
  mcp: McpManager;
  skills: SkillLoader;
  tools: ToolRegistry;
  permission: PermissionManager;
};

export async function bootstrapAll(
  profileId: string,
  config: ResolvedConfig
): Promise<BootstrapResult> {
  // Phase 1: No dependencies
  const [identity, trace, provider, memory, mcp, skills] = await Promise.all([
    bootstrapIdentity(profileId, config),
    bootstrapTrace(profileId, config),
    bootstrapProvider(config),
    bootstrapMemory(profileId, config),
    bootstrapMcp(profileId, config),
    bootstrapSkills(profileId, config),
  ]);

  // Phase 2: Dependencies on skills + mcp
  const { tools, permission } = await bootstrapTools(profileId, config, skills, mcp);

  return {
    identity,
    trace,
    provider,
    memory,
    mcp,
    skills,
    tools,
    permission,
  };
}
```

- [ ] **Step 2: Run TypeScript check**

Run: `bun run tsc --noEmit`
Expected: No errors

---

## Task 7: AgentCore 主类实现

**Files:**
- Create: `src/core/agent-core.ts`
- Create: `src/core/index.ts`
- Create: `tests/core/agent-core.test.ts`

- [ ] **Step 1: 编写失败测试**

```typescript
// tests/core/agent-core.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { AgentCore, createAgentCore } from '../../src/core/agent-core';
import { DEFAULT_PROFILE_ID } from '../../src/config/defaults';
import { DEFAULT_GLOBAL_CONFIG } from '../../src/config/defaults';

describe('AgentCore', () => {
  let core: AgentCore;

  beforeEach(async () => {
    core = await createAgentCore(DEFAULT_PROFILE_ID, DEFAULT_GLOBAL_CONFIG);
  });

  afterEach(async () => {
    await core.shutdown();
  });

  it('should have profileId', () => {
    expect(core.profileId).toBe(DEFAULT_PROFILE_ID);
  });

  it('should have all resources initialized', () => {
    expect(core.provider).toBeDefined();
    expect(core.mcp).toBeDefined();
    expect(core.memory).toBeDefined();
    expect(core.skills).toBeDefined();
    expect(core.tools).toBeDefined();
    expect(core.permission).toBeDefined();
    expect(core.trace).toBeDefined();
    expect(core.identity).toBeDefined();
    expect(core.events).toBeDefined();
  });

  it('should create run context', () => {
    const ctx = core.createRunContext('session-123');
    expect(ctx.sessionId).toBe('session-123');
    expect(ctx.profileId).toBe(DEFAULT_PROFILE_ID);
    expect(ctx.turnId).toBeDefined();
  });

  it('should emit events via event bus', () => {
    let received = false;
    core.events.on('system:warn', () => {
      received = true;
    });
    core.events.emit('system:warn', { code: 'TEST', message: 'test' });
    expect(received).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/core/agent-core.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 AgentCore 类**

```typescript
// src/core/agent-core.ts
import type { ResolvedConfig } from '../config';
import { generateULID, type Ulid } from '../shared';
import { bootstrapAll, type BootstrapResult } from './bootstrap';
import { EventBus } from './runtime/event-bus';
import type { RunContext } from './runtime/run-context';
import type { IdentityStore } from './bootstrap/identity.bootstrap';
import type { TraceWriter } from './bootstrap/trace.bootstrap';
import type { Provider } from './bootstrap/provider.bootstrap';
import type { MemoryStore } from './bootstrap/memory.bootstrap';
import type { McpManager } from './bootstrap/mcp.bootstrap';
import type { SkillLoader } from './bootstrap/skills.bootstrap';
import type { ToolRegistry, PermissionManager } from './bootstrap/tools.bootstrap';

export class AgentCore {
  readonly profileId: string;
  readonly config: ResolvedConfig;

  // Heavy resources
  readonly identity: IdentityStore;
  readonly trace: TraceWriter;
  readonly provider: Provider;
  readonly memory: MemoryStore;
  readonly mcp: McpManager;
  readonly skills: SkillLoader;
  readonly tools: ToolRegistry;
  readonly permission: PermissionManager;

  // Runtime
  readonly events: EventBus;

  constructor(
    profileId: string,
    config: ResolvedConfig,
    resources: BootstrapResult
  ) {
    this.profileId = profileId;
    this.config = config;
    this.identity = resources.identity;
    this.trace = resources.trace;
    this.provider = resources.provider;
    this.memory = resources.memory;
    this.mcp = resources.mcp;
    this.skills = resources.skills;
    this.tools = resources.tools;
    this.permission = resources.permission;
    this.events = new EventBus();
  }

  createRunContext(sessionId: Ulid, frontendId?: string): RunContext {
    return {
      sessionId,
      profileId: this.profileId,
      frontendId,
      turnId: generateULID(),
      abortSignal: new AbortController().signal,
    };
  }

  async shutdown(graceful: boolean = true): Promise<void> {
    this.events.destroy();
    await this.mcp.disconnectAll();
    await this.trace.flush();
  }
}

export async function createAgentCore(
  profileId: string,
  config: ResolvedConfig
): Promise<AgentCore> {
  const resources = await bootstrapAll(profileId, config);
  return new AgentCore(profileId, config, resources);
}
```

- [ ] **Step 4: 创建模块导出**

```typescript
// src/core/index.ts
export * from './types';
export * from './runtime/run-context';
export * from './runtime/event-bus';
export * from './bootstrap';
export * from './agent-core';
```

- [ ] **Step 5: 运行测试验证通过**

Run: `bun test tests/core/agent-core.test.ts`
Expected: 4 passing tests

---

## Task 8: 完整测试与验证

**Files:**
- All files

- [ ] **Step 1: 运行所有 Core 测试**

Run: `bun test tests/core/`
Expected: All tests passing

- [ ] **Step 2: 运行架构检查**

Run: `bun run check:arch`
Expected: No violations (no new module-level singletons)

- [ ] **Step 3: 运行完整 TypeScript 检查**

Run: `bun run tsc --noEmit`
Expected: Only legacy-related errors, no core errors

---

## 验收标准

- [ ] AgentCore 类完整实现，所有资源正确注入
- [ ] EventBus 类型安全，所有事件类型正确
- [ ] Bootstrap 顺序正确，依赖关系清晰
- [ ] RunContext 包含所有必要字段
- [ ] 所有测试通过: `tests/core/` (7+ tests)
- [ ] TypeScript 无类型错误
- [ ] 模块结构清晰，导出完整
