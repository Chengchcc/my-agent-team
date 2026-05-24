# Sub-Agent Spec — `task` 工具与三个 builtin sub-agents

> **Status**: Draft (design-only, no code)
> **Owner**: TBA
> **Tracks**: `sub-agent` extension, `task` tool, TUI widget接入
> **Cross-refs**: 与 [tool-wave-spec.md](./2026-05-24-tool-wave-design.md) 共享 `conflictKey` 协议;与 [plan-mode-spec.md](./2026-05-24-plan-mode-design.md) 在 prompt/白名单上共享常量

---

## 0. 目标与非目标

### 0.1 目标
1. 父 agent 通过 `task` 工具以 **hand-off** 方式委托一段子任务给一个 builtin sub-agent。
2. 三个 builtin sub-agent:**Explore / Plan / General-Purpose**,语义对齐 Claude Code `Task`。
3. Sub-agent 在父进程内运行,使用独立的 ephemeral session、受限工具白名单、独立 abort/permission 域。
4. Sub-agent 的最终文本作为 `task` 工具的返回值回灌父会话,**只暴露一次 `tool.end`**。
5. TUI 提供专用 widget(`subagent.task`),折叠态显示标题+状态,展开态显示内部 tool call 流。
6. 第三方扩展可通过 `subAgents.register(descriptor)` 注册自定义 sub-agent。

### 0.2 非目标
- ❌ 跨进程 sub-agent(单独立项,扩展名 `sub-agent.remote`)。
- ❌ Sub-agent 之间的协商/投票/辩论。
- ❌ Sub-agent 反向问父用户(无 `ask_user_question`,无双向 RPC)。
- ❌ Sub-agent 的持久化(NDJSON)与 `session.list` 暴露。
- ❌ 动态 system prompt 注入(memory/skills 进 sub),MVP 静态。
- ❌ Sub-agent 嵌套 sub-agent(`task` 工具不在 sub 白名单内,运行时硬规则)。

---

## 1. 概念模型

> 一次 sub-agent 调用 = 一次 hand-off。父在一个 turn 内 stop-the-world 等子任务跑完,中间无对话回路。

| 维度 | 父 turn | Sub-agent turn |
|---|---|---|
| Session id | `parentSessionId` | `sub:${parentTurnId}:${ulid}` |
| 持久化 | NDJSON | **不持久化**,仅 trace |
| 工具集 | 完整 | descriptor.allowedToolNames 过滤后 |
| 取消 | 用户 / `input.cancel` | 父 abort 级联 |
| 历史可见性 | `session.list` 可见 | `session.list` **不可见** |
| Compaction | 80k 阈值 | **禁用**(短任务不应到这量级) |

---

## 2. 架构分层

| 层 | 新增 / 修改 |
|---|---|
| `application/contracts/` | **新** `subagent-events.ts`:`subagent.started` / `subagent.completed`;**改** `widget-payload-map.ts` 增加 `subagent.task` 键 |
| `application/usecases/` | 不新增。复用 `runTurnUsecase`,通过新增可选字段 `kind` / `allowedToolNames` 透传 |
| `application/ports/` | **改** `tool.ts`:可选字段 `renderHint?: 'widget' \| 'default'`(用于 TUI widget takeover) |
| `domain/` | 不动 |
| `extensions/sub-agent/` | **新扩展**:`index.ts`、`registry.ts`、`runner.ts`、`task-tool.ts`、`widget-payloads.ts`、`prompts/{explore,plan,general-purpose}.ts` |
| `extensions/tools/` | **改** `index.ts`:在 `resolveTools` hook 内,当 `runCtx.kind === 'sub-agent'` 时按 `allowedToolNames` 过滤 |
| `extensions/frontend.tui/widgets/` | **新** `impls/widget-subagent-task.tsx`;**改** `widget-registry.ts` 注册;**改** projector 让带 widget 的 tool call 跳过默认 `FinalToolCallView` |
| `extensions/dataplane/` | **改** `index.ts`:增加 2 条事件桥(started / completed) |
| `extensions/controlplane.methods/` | **改**:新增 `subagent.list`(只读)、`subagent.invoke`(调试旁路,可选) |
| `extensions/permission/` | 不变。sub session id 天然隔离 deny-list |

---

## 3. 数据模型

### 3.1 `SubAgentDescriptor`

```ts
interface SubAgentDescriptor {
  type: string                                  // 'explore' | 'plan' | 'general-purpose' | <自定义>
  description: string                            // 给父 LLM 看的,决定何时选用
  systemPrompt: string                           // sub 内 transformPrompt 的种子
  allowedToolNames: readonly string[]            // 工具白名单(必填)
  maxRounds?: number                             // 默认沿用 runTurnUsecase 的 10
  maxOutputTokens?: number                       // 默认 8192
  modelHint?: 'fast' | 'strong'                  // provider 适配模型档位(可选)
  source: 'builtin' | 'extension'                // 注册来源标记,builtin 不可被覆盖
}
```

**Invariants**
- `type` 全局唯一;后注册的 builtin **必须抛错**;扩展注册的可被覆盖但需 warn。
- `allowedToolNames` 是显式列表,不支持通配。`task` **永远不在内**(运行时硬规则)。
- `description` 必须以英文动词原型开头(便于 LLM tool-routing)。

### 3.2 三个 builtin

| Type | allowedToolNames | system prompt 关键词 |
|---|---|---|
| `explore` | `read, grep, glob, ls, web_search, web_fetch` | "Investigate, do not modify. Cite paths + line numbers." |
| `plan` | `read, grep, glob, ls` | "Produce numbered steps + acceptance + risks. **Do not call todo_write**." |
| `general-purpose` | `read, grep, glob, ls, bash, text_editor, web_search, web_fetch` | "Complete the task. Report final artifacts." |

> 注意 `plan`(sub-agent)与 `plan-mode`(session-mode)的区别 —— 见 [plan-mode-spec.md](./2026-05-24-plan-mode-design.md) §6 "两个 plan 不打架"。

### 3.3 `task` 工具

| 字段 | 值 |
|---|---|
| `name` | `task` |
| `description` | "Delegate a self-contained sub-task to a sub-agent. Use when the parent agent needs context-isolated investigation or planning." |
| `parameters` | `{ subagent_type: enum, description: string(短), prompt: string(详细) }` |
| `readonly` | `false`(子任务可能写) |
| `conflictKey` | `'subagent:' + input.subagent_type` —— 同类型串行 |
| `renderHint` | `'widget'`(让 TUI 跳过默认 `FinalToolCallView`) |
| 返回 | `string`(sub 的最终文本;失败时为结构化错误字符串) |

### 3.4 事件契约

```ts
'subagent.started'  : { parentTurnId, parentSessionId, type, subSessionId, callId, ts }
'subagent.completed': { parentTurnId, parentSessionId, type, subSessionId, callId,
                        ok: boolean, usage: {input,output},
                        finalText?: string, errorMessage?: string,
                        durationMs: number, ts: number }
```

### 3.5 Widget payload(`subagent.task`)

```ts
interface SubAgentTaskPayload {
  callId: string
  subagentType: string
  description: string
  status: 'running' | 'ok' | 'failed' | 'cancelled'
  subSessionId: string
  innerToolCalls: ReadonlyArray<{
    name: string
    status: 'running' | 'ok' | 'error'
    durationMs?: number
  }>
  finalText?: string
  usage?: { input: number; output: number }
  errorMessage?: string
}
```

**blockId 约定**: `task:${parentTurnId}:${callId}`,流式 `replace`。

---

## 4. 执行协议

### 4.1 Runner 流程

```
runSubAgent({ parentSessionId, parentTurnId, callId, type, description, prompt, parentSignal }):
  desc = registry.get(type) or throw 'unknown_subagent_type'
  subSessionId = `sub:${parentTurnId}:${ulid()}`
  subSignal = controller.signal linked to parentSignal (abort cascade)

  emit 'subagent.started' { ... }
  emit widget_inline_block { mode: 'append', payload: {...status:'running'} }

  history.create(subSessionId, [
    { role: 'system', content: desc.systemPrompt },
    { role: 'user',   content: prompt },
  ])

  try:
    res = await runTurnUsecase({
      sessionId:        subSessionId,
      turnId:           `${parentTurnId}#sub`,
      kind:             'sub-agent',
      allowedToolNames: filterTaskOut(desc.allowedToolNames),  // 硬规则:剥离 'task'
      maxRounds:        desc.maxRounds ?? DEFAULT,
      maxOutputTokens:  desc.maxOutputTokens ?? 8192,
      abortSignal:      subSignal,
      compaction:       'disabled',                            // §6 决策点 D-3
    })
    finalText = lastAssistantTextOf(res)
    emit 'subagent.completed' { ok: true, finalText, usage: res.usage, ... }
    emit widget_inline_block { mode: 'replace', payload: {...status:'ok', finalText, usage} }
    return finalText
  catch (err):
    if (err.name === 'AbortError'):
      emit 'subagent.completed' { ok: false, errorMessage: 'cancelled', ... }
      emit widget_inline_block { mode: 'replace', payload: {...status:'cancelled'} }
      return STRUCTURED_CANCEL_STRING
    emit 'subagent.completed' { ok: false, errorMessage: err.message, ... }
    emit widget_inline_block { mode: 'replace', payload: {...status:'failed', errorMessage} }
    return STRUCTURED_ERROR_STRING(err)
  finally:
    history.drop(subSessionId)  // 不持久化
```

### 4.2 父 turn 视角

父 turn 看到:
- 1 × `tool.start { name:'task', callId }`
- 1 × `widget_inline_block(append, status:'running')`
- N × `widget_inline_block(replace, ...)` —— 内部进度更新
- 1 × `tool.end { name:'task', callId, result: <string> }`(或 `tool.error`)
- 1 × `widget_inline_block(replace, status:'ok'/'failed'/'cancelled')`

> 父 LLM 收到的 `tool.end` 的 `result` 是字符串(成功 = `finalText`,失败 = 结构化错误)。**永远不抛到父 turn 的 `tool.error`**。

---

## 5. Invariants(测试断言)

1. `task` 工具在 sub-agent 自身的 `resolveTools` 输出中**永远不出现**(即使 descriptor 配错)。
2. `ask_user_question` 在所有 builtin sub-agent 的白名单中**永远不出现**(hand-off 模式无人类回路)。
3. 父 `AbortController.abort()` 在 sub turn 的下一 round 边界生效,sub turn 必然终止。
4. `session.list` RPC 返回值**不包含**任何 `sub:*` 前缀的 session id。
5. `subagent.completed` 事件的 `parentTurnId` 必与发起的 `task` 工具调用所在父 turn id 严格相等。
6. Builtin sub-agent 的 `type` 重复注册抛错;扩展 sub-agent 的重复注册 warn 并以后注册者为准。
7. Sub-agent 内部触发 `compactSessionUsecase`(若被错误启用)→ 必须返回 `reason: 'disabled_in_subagent'` 的特殊 reason 而非真正压缩。
8. `task` 工具的 `conflictKey` = `'subagent:' + subagent_type` —— 同类型并发被 wave 调度器串行(依赖 [tool-wave-spec.md](./2026-05-24-tool-wave-design.md))。
9. Widget `subagent.task` 的 `blockId` 在父 turn 范围内唯一,等于 `task:${parentTurnId}:${callId}`。
10. Sub-agent 内的 `write` 工具调用仍走 permission 流;permission deny-list 按 sub session id 隔离,与父 session 隔绝。

---

## 6. 关键决策点(已决)

| ID | 决策 | 选择 | 理由 / 备选 |
|---|---|---|---|
| **D-1** | 进程模型 | 同进程 | 复用 `runTurnUsecase`,无需 IPC |
| **D-2** | Session 持久化 | **不持久化** | sub 是短任务;持久化会污染 `session.list` |
| **D-3** | Sub 内 compaction | **禁用** | sub 应短;若到 80k 说明用法错 |
| **D-4** | 错误回灌方式 | 字符串结果(非抛错) | 与 `tool.error` 区分 |
| **D-5** | Sub 内事件可见性 | 通过 trace 串联,**不**经父 bus | 避免父 session 事件流污染 |
| **D-6** | 取消语义 | 父 abort 级联 | 简化;CC 也是 turn 级 |
| **D-7** | Sub 嵌套 sub | 禁止 | `task` 不在白名单 + runner 硬过滤 |
| **D-8** | Sub 调用 `ask_user_question` | 禁止 | hand-off 无人类回路 |
| **D-9** | Sub 调用 `todo_write` | 禁止(builtin),自定义可放开 | plan 阶段产出靠文本 |
| **D-10** | Sub session id 命名 | `sub:${parentTurnId}:${ulid}` | 可追溯到父;ULID 防碰撞 |
| **D-11** | Sub 失败时 widget 状态 | `'failed'` / `'cancelled'` 区分 | 用户可视区分原因 |
| **D-12** | 父 LLM 的错误返回格式 | XML 标签 + 普通文本 | 给 LLM 强信号 |
| **D-13** | Sub 内 LLM model 选择 | descriptor.modelHint → provider | 成本与延迟优化 |
| **D-14** | Sub 的 `usage` 是否计入父 | **是**,tag `via:subagent:<type>` | 用户视角总成本可见 |
| **D-15** | Sub 内 tool wave 调度 | **启用**(继承父侧设置) | 一致行为 |
| **D-16** | 第三方注册安全边界 | 扩展在 `apply()` 中静态注册 | 防止 LLM 自我扩权 |
| **D-17** | Builtin descriptor 修改 | 不可,需注册新 type | 防止 builtin 被悄改 |
| **D-18** | TUI 折叠默认状态 | **折叠**;按 `enter` 展开 | CC 风格;转录密度优先 |
| **D-19** | Sub-agent 是否可见父 history | 否,只看 system+user(prompt) | hand-off 隔离 |
| **D-20** | `subagent.list` RPC 返回 | type/description/allowedToolNames/source | 不暴露 systemPrompt |

---

## 7. Edge cases

1. **未知 type**:`task({ subagent_type: 'foo' })` → 工具返回 `<sub-agent-error type="unknown_subagent_type"/>`,不抛。
2. **空 prompt**:tool 自校验拒绝(`parse` 阶段)。
3. **Sub 触达 maxRounds**:返回 `<sub-agent-warning type="max_rounds_reached"/>` + 已生成文本。
4. **Sub 内 LLM 拒绝任何工具,只输出文本**:返回该文本,正常完成。
5. **Sub 连续多 round 都不输出文本也不调工具**:第 2 个空 round 视为完成。
6. **父 abort 在 sub `tool.start` 与 `tool.end` 之间**:sub turn 在下一 round 边界终止;widget 标 `cancelled`。
7. **Sub 内 permission 超时**:`write` 30s 无人响应 → sub 工具返回错误 → sub 继续(不退出)。
8. **同父 turn 内 N 个并发 task(不同 type)**:wave 调度允许并行;`subagent:explore` ≠ `subagent:plan`。
9. **同父 turn 内 N 个并发 task(同 type)**:wave 调度强制串行。
10. **Sub 内调用 MCP 工具**:白名单需显式列出 `mcp:srv:tool` 格式才可用。

---

## 8. 当前测试覆盖 & 建议新增

**当前覆盖** — 0 个文件。

**新增:**

```
tests/extensions/sub-agent/
  registry.test.ts                 # 注册去重、builtin 不可覆盖、list 顺序稳定
  task-tool.test.ts                # 输入校验、conflictKey、renderHint、未知 type 错误
  runner-happy.test.ts             # explore 完整 happy path
  runner-cancel.test.ts            # 父 abort 级联到 sub
  runner-recursive.test.ts         # sub 内看不到 'task' 工具
  runner-permission.test.ts        # sub 内 write 走 permission,deny-list 隔离
  runner-failure.test.ts           # provider 抛错 → 结构化错误字符串
  runner-isolation.test.ts         # session.list 不含 sub session
  runner-compaction-disabled.test.ts  # sub 内强制禁用 compaction
  events-parent-turn-id.test.ts    # subagent.started/completed 的 parentTurnId 正确
tests/extensions/frontend.tui/widgets/
  widget-subagent-task.test.tsx    # 4 种状态渲染、innerToolCalls 列表
tests/extensions/frontend.tui/transcript/
  projector-widget-takeover.test.ts # 'task' 的 tool_call_finished 不渲染默认 view
```

---

## 9. 分期里程碑

| 期 | 范围 | 验收 |
|---|---|---|
| **M1** | registry + 三个 descriptor + `task` 工具 + Runner 串行版 | tests: registry / task-tool / runner-happy 三个绿 |
| **M2** | resolveTools 白名单接入 + Explore/Plan 上线 | runner-recursive、permission、白名单测试绿 |
| **M3** | abort 级联 + 错误回灌 + sub session 不持久化断言 + isolation | runner-cancel/failure/isolation 绿 |
| **M4** | dataplane 桥 + `subagent.list` RPC + widget + projector takeover | TUI 端到端 dogfood |
| **M5** | usage 计入父总额 + tag、modelHint 接入 provider | usage 测试绿 |
| **M6**(可选) | 第三方 sub-agent 扩展样板 | 一个 demo 扩展 |

---

## 10. 故意 *不* 做的事

- ❌ Sub-agent 之间共享内存/blackboard。
- ❌ Sub-agent 反向调用父工具。
- ❌ 在 sub 内启用 evolution 触发。
- ❌ Sub-agent 的 RPC 直接暴露给客户端 attach。
- ❌ Sub-agent 的事件流回放(没有 cursor)。

---

## 11. DESIGN.md 落点

- **新增 §4.19 `sub-agent`** 节
- **§4.6 `tools`** 表格新增 `task` 行
- **§4.7 `controlplane.methods`** 新增 `subagent.list`
- **§4.12 `frontend.tui`** 引用新 widget
- **§9 Known-but-not-implemented** 删除 "Sub-agent delegation" 一条
