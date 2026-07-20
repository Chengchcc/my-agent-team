# Spec: Session Tree + Checkpointer 拆分

## Problem

当前 `Checkpointer` 混了两件事：消息持久化（session 职责）+ 执行事件日志（observability 职责）。`Thread.messages` 是线性数组，不支持 fork/回溯/可逆压缩。概念栈三层嵌套（SessionManager -> AgentSession -> Checkpointer），每层都有 id，想加 fork/回溯改不动。

## Goal

1. 拆 `Checkpointer` 为 `MessageStore`（消息树存储）+ `EventLog`（执行事件日志）
2. `Message[]` 升级为 `SessionTreeEntry[]` 树结构，支持 fork/回溯/可逆压缩
3. 引入 `SessionRepo` 接口，实现 SQLite storage

## Design

### Step 1: 拆 Checkpointer

#### 新接口

```typescript
// packages/framework/src/message-store.ts

/** 消息存储 -- session 职责，纯消息持久化。 */
export interface MessageStore {
  load(sessionId: string): Promise<Message[] | null>;
  save(sessionId: string, messages: readonly Message[]): Promise<void>;
  deleteThread?(sessionId: string): Promise<void>;
}

// packages/framework/src/event-log.ts

/** 执行事件日志 -- observability 职责。 */
export interface EventLog {
  appendEvent(sessionId: string, spanId: string | undefined, event: CheckpointEvent): Promise<void>;
  readEvents(sessionId: string, opts?: { spanId?: string }): AsyncIterable<CheckpointEventRow>;
}

// packages/framework/src/interrupt-store.ts

/** 中断状态存储 -- 工具审批暂停/恢复。 */
export interface InterruptStore {
  saveInterrupt(sessionId: string, state: InterruptState): Promise<void>;
  consumeInterrupt(sessionId: string): Promise<InterruptState | null>;
}
```

#### 兼容层

```typescript
// packages/framework/src/checkpointer.ts (保留，作为组合)

/** @deprecated 使用 MessageStore + EventLog + InterruptStore 替代 */
export interface Checkpointer extends MessageStore, Partial<EventLog>, Partial<InterruptStore> {}

/** 组合适配器：从拆分的三个接口构造一个 Checkpointer。 */
export function composeCheckpointer(
  messages: MessageStore,
  events?: EventLog,
  interrupts?: InterruptStore,
): Checkpointer { ... }
```

#### 影响面

- `AgentRuntime`（agent-options.ts）：`checkpointer: Checkpointer` -> `messageStore: MessageStore` + `eventLog?: EventLog` + `interruptStore?: InterruptStore`
- `createAgent`（create-agent.ts）：拆开传递
- `span-loop.ts`：`rt.checkpointer.load/save` -> `rt.messageStore.load/save`，`rt.checkpointer.appendEvent` -> `rt.eventLog?.appendEvent`
- `AgentSession`（harness）：`checkpointer` -> 三个独立接口
- `SessionManager`（harness）：创建时分别构造三个 store
- `sqliteCheckpointer`：拆成 `sqliteMessageStore` + `sqliteEventLog` + `sqliteInterruptStore`，或保留为组合实现

### Step 2: Session Tree

#### 树条目类型

```typescript
// packages/framework/src/session-tree.ts

export interface SessionTreeEntryBase {
  id: string;
  parentId: string | null;
  timestamp: number;
}

export interface MessageEntry extends SessionTreeEntryBase {
  type: "message";
  message: Message;
}

export interface CompactionEntry extends SessionTreeEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface ModelChangeEntry extends SessionTreeEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export type SessionTreeEntry = MessageEntry | CompactionEntry | ModelChangeEntry;

export interface SessionContext {
  messages: Message[];
  model?: { provider: string; modelId: string };
}
```

#### 树存储接口

```typescript
// packages/framework/src/session-storage.ts

export interface SessionStorage {
  getLeafId(): string | null;
  setLeafId(leafId: string | null): Promise<void>;
  createEntryId(): string;
  appendEntry(entry: SessionTreeEntry): Promise<void>;
  getEntry(id: string): SessionTreeEntry | undefined;
  getPathToRoot(leafId: string | null): SessionTreeEntry[];
  getEntries(): SessionTreeEntry[];
}
```

#### Session 类

```typescript
// packages/framework/src/session.ts

export class Session {
  constructor(private storage: SessionStorage) {}

  async appendMessage(message: Message): Promise<string> { ... }
  async buildContext(): Promise<SessionContext> { ... }
  async moveTo(entryId: string | null): Promise<void> { ... }  // fork: 移动叶子到任意节点
  async getBranch(fromId?: string): Promise<SessionTreeEntry[]> { ... }  // 回溯
  async appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number): Promise<string> { ... }
}
```

#### buildSessionContext

从根到叶子的路径构建 messages，处理 compaction 截断：
- 如果路径上有 CompactionEntry，用 summary 替换被压缩的消息，保留 firstKeptEntryId 之后的消息
- 如果路径上有 ModelChangeEntry，记录最终模型

#### 影响面

- `Thread` 替换为 `Session`
- `createAgent` 的 `messages?: Message[]` -> `session?: Session`
- `span-loop.ts`：`rt.thread.messages` -> `rt.session.buildContext()`
- `Checkpointer.load/save` -> `Session.appendMessage/buildContext`
- `summarizingContextManager` 改为调 `session.appendCompaction` 而非替换消息

### Step 3: SessionRepo

```typescript
// packages/framework/src/session-repo.ts

export interface SessionRepo {
  create(options?: { id?: string }): Promise<Session>;
  open(sessionId: string): Promise<Session>;
  list(): Promise<SessionMetadata[]>;
  delete(sessionId: string): Promise<void>;
  fork(sourceSessionId: string, options?: { entryId?: string }): Promise<Session>;
}
```

SQLite 实现：`SessionStorage` 数据存 SQLite 表 `session_tree`（id/sessionId/parentId/type/timestamp/data JSON）。

## Migration Path

### Phase 1: 拆 Checkpointer（1 周）

1. 定义 `MessageStore` / `EventLog` / `InterruptStore` 接口
2. `Checkpointer` 改为 extends 三个接口（向后兼容）
3. `AgentRuntime` / `createAgent` / `span-loop` / `AgentSession` / `SessionManager` 逐步改用新接口
4. `sqliteCheckpointer` 内部拆分实现，外部 API 不变
5. 全量 typecheck + test 通过
6. 此时行为不变，只是接口拆分

### Phase 2: Session Tree（2-3 周）

1. 定义 `SessionTreeEntry` / `SessionStorage` / `Session` 类型
2. 实现 `MemorySessionStorage` + `SqliteSessionStorage`
3. `Thread` 改为 `Session`，`thread.messages` 改为 `session.buildContext()`
4. `createAgent` / `span-loop` / `AgentSession` 适配
5. `summarizingContextManager` 改用 `session.appendCompaction`
6. 实现 `moveTo`（fork）和 `getBranch`（回溯）
7. 全量 typecheck + test 通过
8. 此时支持 fork/回溯/可逆压缩

### Phase 3: SessionRepo（1 周）

1. 定义 `SessionRepo` 接口
2. 实现 `SqliteSessionRepo`（create/open/list/delete/fork）
3. `SessionManager` 改用 `SessionRepo`
4. 全量 typecheck + test 通过

## Files Touched

### Phase 1
- 新增: `packages/framework/src/message-store.ts`, `event-log.ts`, `interrupt-store.ts`
- 修改: `packages/framework/src/checkpointer.ts`（改为 extends）
- 修改: `packages/framework/src/agent-options.ts`（AgentRuntime 拆字段）
- 修改: `packages/framework/src/create-agent.ts`（传递拆分接口）
- 修改: `packages/framework/src/span-loop.ts`（用新接口）
- 修改: `packages/harness/src/agent-session.ts`, `session-manager.ts`
- 修改: `packages/framework/src/checkpointers/sqlite-checkpointer.ts`（内部拆分）
- 修改: `packages/framework/src/checkpointers/in-memory.ts`

### Phase 2
- 新增: `packages/framework/src/session-tree.ts`, `session-storage.ts`, `session.ts`
- 新增: `packages/framework/src/storages/memory-session-storage.ts`, `sqlite-session-storage.ts`
- 修改: `packages/framework/src/thread.ts`（删除或改为 Session 别名）
- 修改: `packages/framework/src/create-agent.ts`, `span-loop.ts`, `agent-options.ts`
- 修改: `packages/harness/src/agent-session.ts`, `session-manager.ts`
- 修改: `packages/framework/src/context-managers/summarizing.ts`（用 appendCompaction）

### Phase 3
- 新增: `packages/framework/src/session-repo.ts`
- 新增: `packages/framework/src/repos/sqlite-session-repo.ts`
- 修改: `packages/harness/src/session-manager.ts`（用 SessionRepo）

## 不做

- 不做 JSONL session storage（SQLite 够用）
- 不做 `ThinkingLevelChangeEntry` / `ActiveToolsChangeEntry`（我们没有 thinking level / 动态工具切换）
- 不做 `LabelEntry` / `CustomEntry` / `CustomMessageEntry`（不需要）
- 不做 `BranchSummaryEntry`（fork 时不需要自动生成摘要）
- 不做前端 UI（fork/回溯的 UI 是后续工作）
