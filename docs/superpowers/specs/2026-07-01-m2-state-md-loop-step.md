# M2 Spec — STATE.md 文件读写 + loopStep() 基础编排

> **Status:** 🏗 Design → Implementation
> **Baseline:** M1（loopReducer 纯函数 + 37 测试）完成态。
> **关联:** `docs/adr/0001-loop-prune-is-post-processing.md` · `docs/adr/0003-state-md-single-writer.md` · `packages/loop/src/loop-reducer.ts`

**Goal:** 落地 STATE.md/INBOX.md 文件读写 + loopStep() 读文件→调 reducer→写回的基础回路。不接 AgentSession（M3），不加锁（M4）。

**Non-goals:**
- 不调用 AgentSession（M3）
- 不引入写锁、预算计数、CronJob 集成（M4）
- 不做 STATE.md 格式演化/迁移
- 不解析 config.yml

---

## 1. STATE.md 格式

```
---
loopId: morning-triage
lastRun: 2026-07-01T08:15:00Z
version: 1
---

# Loop State — Morning Triage

## Items

### 01JN7X8K3M
source: ci/4821
summary: auth 超时
step: verifying
attempt: 1
priority: 0

### 01JN7X9A2B
source: issue/92
summary: parser 空指针
step: fixing
attempt: 2
result:
  verdict: REJECT
  reasons:
    - scope drift
  evidence: touched 5 files
```

- `---` frontmatter 存 loopId、lastRun、version
- `### <id>` 锚点 = item section，每个 section 内是 YAML 字典
- `result` 为 null → section 内不出现 `result:` 行
- `result` 存在时是嵌套 Verdict 对象，原样 YAML 序列化

## 2. INBOX.md 格式

```
### 01JN8A1B2C
source: ci/4821
summary: auth 超时
step: inbox
attempt: 3
result:
  verdict: REJECT
  reasons:
    - scope drift
  evidence: touched 5 files

### 01JN9C3D4E
source: manual
summary: 重构用户模块
step: inbox
attempt: 1
result:
  verdict: REJECT
  reasons:
    - 手动驳回
  evidence: ""
```

- 与 STATE.md item section 格式完全一致
- 无 frontmatter——inbox 不绑定单次 run
- 写入策略：**全量覆盖**——当前所有 inbox item 的快照（同 id 多次驳回只保留最新一条）

## 3. 类型定义（M1 基础上扩展）

```typescript
// 不变：LoopState, ItemState, Verdict, LoopAction 已在 types.ts

// M2 新增
type InboxState = Record<ItemId, ItemState>;  // 所有 item 的 step = "inbox"
```

## 4. state-md.ts — 解析与格式化

### 函数签名

```typescript
// STATE.md
function parseStateMd(md: string): LoopState
function formatStateMd(state: LoopState): string

// INBOX.md
function parseInboxMd(md: string): InboxState
function formatInboxMd(items: InboxState): string
```

### 解析逻辑

`parseStateMd(md)`:
1. 找第一个 `---` 到第二个 `---`，YAML-parse → loopId, lastRun, version
2. 找 `## Items` 后的所有 `### <id>` sections
3. 每个 section 内 YAML-parse → ItemState（step 从 YAML key 读）
4. 拼成 `Record<ItemId, ItemState>` → `LoopState`

`parseInboxMd(md)`:
1. 找所有 `### <id>` sections
2. 同解析逻辑 → InboxState

### 格式化逻辑

`formatStateMd(state)`:
1. 写 frontmatter：loopId, lastRun, version
2. `## Items` heading
3. 遍历 items，每个写 `### <id>` + YAML 字典
4. result 为 null → 省略 `result:` 行
5. YAML 缩进 2 空格，嵌套结构保持

`formatInboxMd(items)`:
1. 同 `###` section 格式，无 frontmatter、无 `## Items` heading

### 不依赖第三方 YAML 库

手写 frontmatter 解析 + 行级 YAML 序列化。Item section 内的 YAML 只有两层嵌套（result + reasons），不需要完整 YAML parser。

## 5. loop-step.ts — 基础编排

```typescript
function loopStep(params: {
  loopConfigPath: string;
  action?: {
    itemId: string;
    verdict: "approve" | "reject" | "promote" | "retry" | "dismiss";
    feedback?: string;
  };
}): Promise<LoopState>
```

### 流程

```
1. 读 STATE.md → parseStateMd → LoopState
   读 INBOX.md → parseInboxMd → InboxState（如果文件存在）

2. 如果有 action（人 review）:
   - 查 item 在 STATE.md 还是 INBOX.md → 取对应 state
   - 调 loopReducer(state, action)
   - RETRY: 从 INBOX.md 取 item → reducer TICK_OK → 写回 STATE.md，从 INBOX.md 删除
     实现: retryItems = filter(inboxState, step==="inbox" && id===action.itemId)
           state.items = { ...state.items, ...retryItems }
           inboxState = filter(inboxState, id!==action.itemId)
           state = loopReducer(state, { type: "TICK" })

3. 如果是 cron TICK（无 action）:
   - 调 loopReducer(state, { type: "TICK" })
   - triaged → fixing（停在 fixing，M3 接 generator）

4. 写回:
   - STATE.md: state 中 prune 掉 step ∈ {resolved, promoted} 的 item → formatStateMd → 写文件
   - INBOX.md: state 中取出 step === "inbox" 的 item + 已有 inbox item → formatInboxMd → 写文件

5. 返回新 state
```

### TICK 停在 fixing

M2 不接 generator。TICK 后 item 在 `fixing`——loopStep() 不尝试起 AgentSession。M3 接线后 cron handler 在 loopStep() 返回后自己起 generator。

## 6. 验收标准

### parseStateMd / formatStateMd

1. **空文件 → 空 state**：parseStateMd("") → `{ items: {} }`
2. **完整 STATE.md**：解析 loopId, lastRun, 所有 item（含 result）
3. **缺失 result 字段**：item.result = null
4. **format + parse 等价**：`parseStateMd(formatStateMd(state))` → 与原始 state 等价
5. **format 不输出 null result**：result=null 的 item 在 STATE.md 中无 `result:` 行
6. **多 item**：3+ items 正确解析和格式化

### parseInboxMd / formatInboxMd

7. **空文件 → 空 inbox**：parseInboxMd("") → `{}`
8. **完整 INBOX.md**：解析所有 inbox item
9. **format + parse 等价**
10. **DISMISS 后消失**：inbox item DISMISS → formatInboxMd 不包含该 item

### loopStep()

11. **TICK → triaged → fixing**：读 STATE.md → loopStep({ loopConfigPath }) → 所有 triaged item 变 fixing，写回
12. **APPROVE → resolved**：loopStep({ action: { itemId, verdict: "approve" } }) → item 变 resolved，写回后被 prune
13. **REJECT_HUMAN → inbox**：item 从 STATE.md 移除，出现在 INBOX.md
14. **RETRY → triaged**：item 从 INBOX.md 移到 STATE.md（step=triaged, attempt=1）
15. **DISMISS → 删除**：item 从 INBOX.md 消失
16. **PROMOTE → promoted**：写回后 prune
17. **空 STATE.md + TICK**：不变
18. **不存在的 itemId**：读文件不变，不写回
19. **不可变**：loopStep 内部不修改入参

## 7. 实施分组

| Patch | 内容 | 文件 |
|---|---|---|
| P1 | state-md.ts：parse + format 四个函数 | `packages/loop/src/state-md.ts` |
| P2 | state-md.test.ts：字符串级测试 | `packages/loop/src/state-md.test.ts` |
| P3 | loop-step.ts：读文件 → reducer → 写回 | `packages/loop/src/loop-step.ts` |
| P4 | loop-step.test.ts：临时目录测试 | `packages/loop/src/loop-step.test.ts` |
| P5 | index.ts 导出新增 | `packages/loop/src/index.ts` |
| P6 | 全 workspace typecheck + lint + test | — |

## 8. 风险

1. **YAML 手写解析器边界**：只解析两层嵌套（result 对象 + reasons 数组）。嵌套超过两层或非标准 YAML 结构 → 解析失败，返回空 state。
2. **INBOX.md 全量覆盖 vs 追加**：REMOVE item 后写回时覆盖整个 INBOX.md——如果并发写（crash 后残留），可能丢数据。此风险由 M4 写锁兜底。
3. **RETRY 的"移到 STATE.md 然后 TICK"是两步**：先 ADD_ITEM 把 item 注入 state，再 TICK 推进。如果中间崩了——item 在 state 里是 triaged，下次 TICK 推走。可接受。
