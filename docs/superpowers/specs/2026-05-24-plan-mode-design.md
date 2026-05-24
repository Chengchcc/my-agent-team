# Plan Mode Spec — Session-level Mode + `exit_plan_mode` 工具

> **Status**: Draft (design-only, no code)
> **Owner**: TBA
> **Tracks**: 新扩展 `session-mode`、`Session` 聚合根新增 `mode` 字段、`exit_plan_mode` 工具、TUI chrome + widget
> **Cross-refs**: 与 [sub-agent-spec.md](./2026-05-24-sub-agent-design.md)(共享 `plan` prompt 与只读白名单常量);与 [tool-wave-spec.md](./2026-05-24-tool-wave-design.md)(`exit_plan_mode` 的 `conflictKey`)

---

## 0. 目标与非目标

### 0.1 目标
1. 引入 **Session-level Mode** 抽象:`session.mode ∈ { 'normal' | 'plan' | <future> }`,持续到用户主动退出。
2. 实现 `'plan'` mode:工具白名单退化为只读集合(可写 `todo_write`),system prompt 注入 plan 段落。
3. 提供 `exit_plan_mode` 工具:LLM 生成最终 plan 后调用,**不自动切 mode**,由用户审批。
4. 提供切换通道:`/mode <name>`、`/plan`、`/exit-plan` slash;TUI 内 `shift+tab` 热键;`session.setMode` RPC。
5. Mode 状态随 NDJSON 持久化,daemon resume 后保留。
6. TUI 顶部 chrome 显示 `[PLAN MODE]` 状态条,plan 提案显示为专用 widget。
7. Mode 抽象通用:可扩展为 `'accept-edits'` / `'bypass-permissions'` 等(本 spec 只做 `'plan'`)。

### 0.2 非目标
- ❌ Mode 多选/叠加。一次仅一个 active mode。
- ❌ 细粒度写权限策略。MVP 二元化:只读 + todo。
- ❌ 把 plan 做成 sub-agent。语义不同 —— 见 §6。
- ❌ 把 plan 做成 skill。语义反了 —— 见 §6。
- ❌ Plan 阶段对话的隐藏。
- ❌ Plan 提案需要审批后**自动**切 normal:用户必须显式 approve。
- ❌ Plan 跨 session 共享。

---

## 1. 概念模型

> Mode 是 **session 的横切状态**,影响后续所有 turn 的 system prompt + 工具白名单 + tool 拦截。

| 维度 | Skill | Sub-agent | **Mode** |
|---|---|---|---|
| 注入点 | `resolveTools`(+) | `task` 工具 | `transformPrompt` + `resolveTools`(×过滤)+ `onToolCall` |
| 触发方 | LLM | LLM | **用户** |
| 生命周期 | 单工具调用 | 单 hand-off | 直到用户退出 |
| 影响范围 | 单 turn | sub session | 当前 session 的所有后续 turn |
| 持久化 | — | — | 是,随 session NDJSON |

---

## 2. 架构分层

| 层 | 新增 / 修改 |
|---|---|
| `domain/session.ts` | **改**:`Session` 聚合根新增 `mode: string`(默认 `'normal'`) |
| `application/contracts/` | **新**:`session.modeChanged`、`session.planProposed`、`session.planResolved` |
| `application/contracts/widget-payload-map.ts` | **改**:增加 `session.plan-proposal` 键 |
| `application/usecases/run-turn.ts` | **改**:读取 `session.mode`,塞入 `runCtx`,透传到 `transformPrompt` / `resolveTools` / `onToolCall` |
| `application/slash/` | **新**:`/mode <name>`、`/plan`、`/exit-plan` builtin |
| `extensions/session-mode/` | **新扩展**:`index.ts`、`registry.ts`、`guards.ts`、`prompts/plan.ts`、`widget-payloads.ts` |
| `extensions/session/` | **改**:NDJSON 持久化时序列化 `mode` 字段;`restoreFromDisk` 反序列化 |
| `extensions/tools/` | **改**:`resolveTools` 配合 mode descriptor 的 `toolFilter` |
| `extensions/tools/exit-plan-mode.ts` | **新工具**:emit `session.planProposed`,**不自动切 mode** |
| `extensions/controlplane.methods/` | **改**:新增 `session.setMode/getMode/resolvePlan` |
| `extensions/dataplane/` | **改**:增加 3 条事件桥 |
| `extensions/frontend.tui/` | **改**:顶部 chrome 显示 mode 标签;`shift+tab` 绑定;新 widget `widget-plan-proposal.tsx` |

---

## 3. 数据模型

### 3.1 `ModeDescriptor`

```ts
interface ModeDescriptor {
  name: string                                          // 'plan' | 'accept-edits' | ...
  description: string                                   // /mode 列表用
  systemPromptAppend: string                            // transformPrompt 拼接
  toolFilter: (tool: ToolDescriptor) => boolean         // resolveTools 过滤
  toolGuard?: (call: ToolCall) => null | { reason: string }   // onToolCall 拦截(双保险)
  onEnter?: (ctx: KernelContext, sessionId: string) => void | Promise<void>
  onExit?:  (ctx: KernelContext, sessionId: string) => void | Promise<void>
  source: 'builtin' | 'extension'
}
```

### 3.2 Builtin `'plan'` descriptor

```ts
{
  name: 'plan',
  description: 'Research and propose a plan without making changes.',
  systemPromptAppend: PLAN_MODE_PROMPT,
  toolFilter: (t) =>
    t.readonly === true || t.name === 'todo_write' || t.name === 'exit_plan_mode',
  toolGuard: (call) => null,
  source: 'builtin',
}
```

### 3.3 `PLAN_MODE_PROMPT`(常量)

> 你处于 **Plan Mode**。你的目标是与用户讨论并细化方案,**不能修改文件、不能执行 bash**。当方案明确后,调用 `exit_plan_mode({ plan: <markdown> })` 提交方案给用户审批。审批通过前,任何写操作都将被拒绝。

### 3.4 `exit_plan_mode` 工具

| 字段 | 值 |
|---|---|
| `name` | `exit_plan_mode` |
| `description` | "Submit the final plan for user approval." |
| `parameters` | `{ plan: string(markdown) }` |
| `readonly` | `true`(不写文件) |
| `conflictKey` | `'mode:global'` |
| `renderHint` | `'widget'` |
| 副作用 | emit `session.planProposed`;**不自动切 mode** |
| 返回 | `"Plan submitted. Awaiting user decision."` |

### 3.5 事件契约

```ts
'session.modeChanged'  : { sessionId, from: string, to: string, ts: number }
'session.planProposed' : { sessionId, planMd: string, callId: string, ts: number }
'session.planResolved' : { sessionId, decision: 'approve' | 'reject' | 'keep', ts: number }
```

### 3.6 Widget payload(`session.plan-proposal`)

```ts
interface PlanProposalPayload {
  callId: string
  planMd: string
  status: 'proposed' | 'approved' | 'rejected' | 'superseded'
  proposedAt: number
  resolvedAt?: number
}
```

**blockId 约定**: `plan:${turnId}:${callId}`,流式 `replace`。

---

## 4. 切换通道

| 通道 | 实现 | 路径 |
|---|---|---|
| Slash `/mode plan` | `application/slash` builtin | → `session.setMode { mode:'plan' }` |
| Slash `/mode normal` | 同上 | → `session.setMode { mode:'normal' }` |
| Slash `/plan`(别名) | 同上 | → `setMode('plan')` |
| Slash `/exit-plan`(别名) | 同上 | → `setMode('normal')` |
| TUI `shift+tab` | `frontend.tui` | → `setMode(toggle)` |
| TUI plan 卡片 Approve | widget action | → `session.resolvePlan({ decision:'approve' })` |
| TUI plan 卡片 Reject | widget action | → `session.resolvePlan({ decision:'reject' })` |
| TUI plan 卡片 Keep planning | widget action | → `session.resolvePlan({ decision:'keep' })` |
| 程序化 RPC | 直接调 `session.setMode` | controlplane.methods |

---

## 5. 完整交互序列(Approve 路径)

```
1. 用户: /plan
   → session.setMode { mode: 'plan' }
   → emit 'session.modeChanged' { from:'normal', to:'plan' }
   → TUI chrome 顶部出现 [PLAN MODE]

2. 用户与 agent 在 plan mode 下对话 N 轮
   - 每个 turn 的 resolveTools 输出 = readonly 工具 + todo_write + exit_plan_mode

3. agent 调用 exit_plan_mode({ plan: "## Step 1...\n## Step 2..." })
   → emit 'session.planProposed' { planMd, callId }
   → emit widget_inline_block(append)

4a. 用户在 widget 卡片点 Approve
   → RPC session.resolvePlan({ decision:'approve' })
   → emit 'session.planResolved' { decision:'approve' }
   → session.setMode('normal')
   → history 注入 "Plan approved by user. You may now execute."

4b. 用户点 Keep planning
   → RPC session.resolvePlan({ decision:'keep' })
   → 留 plan mode
   → history 注入 "User wants more planning. Refine the plan."

4c. 用户点 Reject
   → history 注入 "User rejected the plan. Reconsider."
```

---

## 6. 与 sub-agent 的 `plan` 的区别

| 维度 | Sub-agent `plan` | Session-mode `plan` |
|---|---|---|
| 触发方 | LLM 自主调用 `task({ subagent_type: 'plan' })` | 用户切换 `/plan` |
| 生命周期 | 单次 hand-off | 直到用户退出 |
| 上下文 | 独立 ephemeral session | 当前 session 持续累加 |
| 用户视角 | "agent 派了个规划助手快速给方案" | "我现在和 agent 一起规划" |
| 持久化 | 不(只有 trace) | 持久化 |
| 工具集 | 静态白名单(read/grep/glob/ls) | 同样白名单,但作用于父 session 所有后续 turn |

**共享:** `read/grep/glob/ls` 白名单常量、PLAN_PROMPT 的核心动词。

---

## 7. Invariants(测试断言)

1. `session.mode` 默认 `'normal'`;新建 session 显式赋默认值。
2. `session.setMode { mode: <unknown> }` → registry 查不到 → RPC 错误码 `'unknown_mode'`,**不切**。
3. Mode 切换在 turn 进行中发生 → **下一**个 turn 生效。
4. plan mode 下,`resolveTools` 输出 = `{readonly tools} ∪ {todo_write, exit_plan_mode}`,严格不含 `bash/write/text_editor/task`。
5. plan mode 下 toolGuard 双保险:即便走漏到 onToolCall,直接拒绝。
6. `exit_plan_mode` → emit `session.planProposed` → **mode 不自动变化**。
7. `session.resolvePlan { decision:'approve' }` 必然伴随 `session.modeChanged { to:'normal' }`。
8. `session.resolvePlan { decision:'keep' | 'reject' }` **不**变更 mode。
9. NDJSON 持久化 `mode` 字段;daemon 重启 + restore → `getMode` 返回原值。
10. plan mode 下 sub-agent `task` 工具被白名单排除。
11. plan widget 的 `blockId` 在父 turn 范围内唯一;`status` 不可逆转移。
12. 同一 session 同一时刻只能有一个 active proposal:第二个 `exit_plan_mode` 让前一个 `superseded`。
13. `exit_plan_mode({ plan: '' })` → tool 自校验拒绝。
14. plan mode 切换至 normal 时,history 末尾有且仅有一条带特定 marker 的 system message。
15. Builtin `'plan'` mode 不可被覆盖注册。

---

## 8. 关键决策点(已决)

| ID | 决策 | 选择 | 理由 |
|---|---|---|---|
| **D-1** | Plan 是工具/skill/sub-agent/mode? | **Mode** | 用户主动切换 + 整 session 影响 + 持久化 |
| **D-2** | 切换是否立即生效本 turn | **下一 turn 生效** | 本 turn resolveTools 已完成 |
| **D-3** | exit_plan_mode 是否自动切 normal | 否,等用户审批 | 避免 LLM 单方面"宣布完成" |
| **D-4** | Plan 模式下允许 todo_write 吗 | 是 | 规划本身就是产出 todo |
| **D-5** | Plan 模式下允许 task(sub-agent) 吗 | **否** | 规划阶段不该派子 agent 干活 |
| **D-6** | Plan 模式下允许 web_search/web_fetch 吗 | 是(readonly) | 调研需要联网 |
| **D-7** | Reject 后是留 plan mode 还是回 normal | **默认留** | 用户可能想继续改方案 |
| **D-8** | "User rejected" 是否注入 history | 是,带 marker | 模型下一 turn 知情 |
| **D-9** | Keep planning 后 widget 状态 | 仍 `'proposed'` | 后续 exit_plan_mode 会把它标 `superseded` |
| **D-10** | 同 session 多个并发 proposal | 不允许,后者使前者 superseded | 简化用户决策面 |
| **D-11** | Mode 是否影响 transformPrompt 顺序 | mode prompt 在最后追加(post 优先) | 其他扩展不能撤销 plan 限制 |
| **D-12** | mode 持久化字段 | NDJSON session 文件头部 meta 行 | 复用现有 NDJSON |
| **D-13** | mode 切换是否触发 turn 中断 | 否 | 切换只影响下一 turn |
| **D-14** | mode 是否对 frontend.lark 生效 | 是,后端语义统一 | Lark 降级为 markdown |
| **D-15** | mode 是否对 sub-agent 内部生效 | **不生效**(独立 session) | 隔离 |
| **D-16** | Mode descriptor 注册时机 | `apply()` 中静态注册 | 防 LLM 自我扩权 |
| **D-17** | Builtin mode 可否被同名覆盖 | 否,抛错 | 防 builtin 被悄改 |
| **D-18** | exit_plan_mode 的 plan 字段长度上限 | 软限制 32KB | 防 LLM 输出爆炸 |
| **D-19** | Mode 改名后旧 NDJSON 兼容 | 查不到 → fallback `'normal'` + warn | 不破坏现有 session |
| **D-20** | mode 切换是否计入 trace | 是 | 审计 |

---

## 9. Edge cases

1. **未知 mode**:`session.setMode { mode: 'foo' }` → RPC 错误,不切。
2. **Resume 一个 plan mode session**:NDJSON restore → mode='plan' → 下一 turn resolveTools 仍受限。
3. **Plan 模式下 LLM 想调 `write`**:不在 resolved list,模型看不到。
4. **嵌套 sub-agent 在 plan 模式下被请求**:`task` 不在白名单 → 不可用。
5. **Mode descriptor `onEnter` 抛错**:不切,保持原 mode。
6. **`exit_plan_mode` 在 normal mode 被调用**:工具不可见。
7. **用户拒绝 plan 后继续 plan**:历史保留 planProposed 记录 + reject 注入。
8. **空 plan**:`exit_plan_mode({ plan:'' })` → 工具自校验拒绝。
9. **并发 setMode**:两次 RPC 同时到达 → 后到者胜(RPC 串行)。
10. **`shift+tab` 在 plan mode 下**:切回 normal,但若有未决 proposal → 提示用户先 resolve。
11. **同一 session 两个 proposal**:后者 supersede 前者, widget 更新。

---

## 10. 当前测试覆盖 & 建议新增

**当前覆盖** — 0 个文件。

**新增:**

```
tests/extensions/session-mode/
  registry.test.ts                  # mode 注册、未知 mode 错误、内置 plan 存在、不可覆盖
  plan-mode-tools.test.ts           # 工具过滤:只 readonly + todo_write + exit_plan_mode
  plan-mode-prompt.test.ts          # transformPrompt 注入 PLAN_MODE_PROMPT 在末尾
  plan-mode-guard.test.ts           # toolGuard 双保险
  exit-plan-mode-tool.test.ts       # emit planProposed,不自动切 mode,空 plan 拒绝
  mode-persistence.test.ts          # NDJSON 持久化 + restore + 未知 mode fallback
  mode-switch-mid-turn.test.ts      # 切换在下一 turn 生效
  mode-rpc.test.ts                  # session.setMode/getMode/resolvePlan RPC
  resolve-plan.test.ts              # approve/reject/keep 三种路径 + history 注入
  multi-proposal.test.ts            # 第二个 exit_plan_mode 让前一个 superseded
  sub-agent-task-blocked.test.ts    # plan mode 下 task 工具不可见
tests/extensions/frontend.tui/widgets/
  widget-plan-proposal.test.tsx     # 4 种状态渲染
tests/extensions/frontend.tui/chrome/
  mode-indicator.test.tsx           # 顶部 [PLAN MODE] 标签
tests/extensions/frontend.tui/input/
  shift-tab-toggle.test.ts          # 热键切换 + 未决 proposal 警告
tests/application/slash/
  mode-commands.test.ts             # /mode /plan /exit-plan
```

---

## 11. 分期里程碑

| 期 | 范围 | 验收 |
|---|---|---|
| **M1** | `Session.mode` 字段 + registry + builtin `'plan'` descriptor + `transformPrompt`/`resolveTools`/`onToolCall` 接入 | registry/tools/prompt/guard 测试绿 |
| **M2** | `exit_plan_mode` 工具 + 事件 + RPC + slash | exit-plan-mode、mode-rpc、resolve-plan 测试绿 |
| **M3** | NDJSON 持久化 mode + restore + mid-turn 切换语义 + multi-proposal | persistence、mid-turn-switch、multi-proposal 测试绿 |
| **M4** | TUI 顶部 mode 标识 + plan widget + `shift+tab` 绑定 | 端到端 dogfood |
| **M5**(可选) | 第二个 mode(`accept-edits`)验证抽象通用性 | registry 接入新 mode 零改动 |
| **M6**(可选) | Lark 端的降级 markdown 渲染 | Lark 测试绿 |

---

## 12. 故意 *不* 做的事

- ❌ 把 plan mode 强制做成 sub-agent。
- ❌ 把 plan mode 做成 skill。
- ❌ Plan mode 下允许部分写。
- ❌ Mode 多选/叠加。
- ❌ 隐藏 plan 阶段对话。
- ❌ Plan 提案的版本历史。

---

## 13. 与其他 spec 的协同

- **sub-agent**:`task` 工具的 `conflictKey = 'subagent:<type>'`;在 plan mode 下被白名单排除。
- **tool-wave**:`exit_plan_mode` 的 `conflictKey = 'mode:global'`,readonly = true。
- **TUI widget 体系**:plan-proposal widget 与 sub-agent task widget 共享同一 `widget_inline_block` 基础设施。

---

## 14. DESIGN.md 落点

- **新增 §4.20 `session-mode`** 节
- **§3 Domain Layer** 表格:`Session` 加 `mode: string` 字段说明
- **§4.6 `tools`** 表格新增 `exit_plan_mode` 行
- **§4.7 `controlplane.methods`** 新增 `session.setMode/getMode/resolvePlan`
- **§4.12 `frontend.tui`** 引用新 chrome bar + plan widget
- **§9 Known-but-not-implemented**:无需改动
