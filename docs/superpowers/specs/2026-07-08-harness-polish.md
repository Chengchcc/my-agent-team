# Spec: Harness 层打磨 -- 封装修复 + 质量建设 + 清理

> 状态：待评审
> 设计约束：`docs/architecture/design-philosophy.md` -- 边界要硬，概念要少

## 1. 目标

修复 harness 层唯一的封装破裂点 + 3 项质量建设 + 1 项清理。

## 2. P0: 封装修复 -- 消除 `as SessionWithCheckpointer`

### 2.1 问题

`apps/backend/src/features/loop/loop-step.ts:60-70` 的 `tallyUsage()` 把 `AgentSession` cast 成 `SessionWithCheckpointer`，直接读 `#config.checkpointer.readEvents()`。这是穿透 harness private 封装的 hack，用 `as` 绕过类型检查。

### 2.2 修复

在 `AgentSession` 上加 `getUsage(): Promise<number>` 方法：

```typescript
async getUsage(): Promise<number> {
  if (!this.#config.checkpointer?.readEvents || !this.#config.sessionId) return 0;
  let tokens = 0;
  for await (const ev of this.#config.checkpointer.readEvents(this.#config.sessionId)) {
    if (ev.usage) {
      tokens += (ev.usage.input ?? 0) + (ev.usage.output ?? 0);
    }
  }
  return tokens;
}
```

loop-step.ts 删除 `SessionWithCheckpointer` 接口 + `as` cast，改为 `session.getUsage()`。

### 2.3 验收

- `AgentSession` 有 `getUsage()` 方法
- `loop-step.ts` 不再有 `as SessionWithCheckpointer`
- `loop-step.test.ts` 通过

## 3. P1: 删除 `setModel`

### 3.1 问题

`AgentSession.setModel(model)` 直接写 `this.#config.model = model`。无调用方。运行中改 model 会导致已初始化的 `#agent` 与 config 不一致。

### 3.2 修复

删除 `setModel` 方法。确认无调用方（grep 验证）。

### 3.3 验收

- `AgentSession` 无 `setModel`
- typecheck 通过

## 4. P1: `waitForIdle` 改 promise-based

### 4.1 问题

`waitForIdle()` 用 50ms 轮询检查 state。busy-poll，响应延迟。

### 4.2 修复

改为 subscribe + resolve 模式：

```typescript
async waitForIdle(): Promise<void> {
  if (this.#state !== "running" && this.#state !== "compacting" && this.#state !== "retrying" && this.#state !== "waiting") {
    return;
  }
  return new Promise<void>((resolve) => {
    const unsub = this.subscribe((event) => {
      if (event.type === "agent_end") {
        unsub();
        resolve();
      }
    });
  });
}
```

### 4.3 验收

- `waitForIdle` 不用 `setTimeout`
- 测试通过

## 5. P1: `#handleError` abort 判断改 `err.name`

### 5.1 问题

`if (msg.includes("abort") || msg.includes("AbortError"))` -- 字符串匹配脆弱。

### 5.2 修复

```typescript
#handleError(err: unknown): void {
  const errorName = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  this.#lastError = msg;
  if (errorName === "AbortError" || msg.includes("abort")) {
    this.#state = "done";
  }
}
```

保留 `msg.includes("abort")` 作为兜底（有些错误不是标准 AbortError），但优先检查 `err.name`。

### 5.3 验收

- `#handleError` 优先检查 `err.name === "AbortError"`
- 测试通过

## 6. P2: 删除 `ContextUsage.totalTokens` 死字段

### 6.1 问题

`ContextUsage.totalTokens` 从未被设值或读取。

### 6.2 修复

删除 `totalTokens?: number` 字段。

### 6.3 验收

- `ContextUsage` 无 `totalTokens`
- typecheck 通过

## 7. 验收标准

1. `AgentSession` 有 `getUsage()` 方法，loop-step 不再 `as` cast
2. `AgentSession` 无 `setModel`
3. `waitForIdle` 不用 `setTimeout` 轮询
4. `#handleError` 优先检查 `err.name`
5. `ContextUsage` 无 `totalTokens`
6. typecheck + test + lint 全绿
