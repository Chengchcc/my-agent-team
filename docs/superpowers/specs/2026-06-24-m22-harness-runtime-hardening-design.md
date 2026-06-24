# M22 Spec — Harness 运行时加固：长任务 / 并行 / 可干预 / 技能完备

> **Status:** Spec → Ready for implementation.
> **Baseline:** `master` @ `220a7012`.
> **关联:** `docs/architecture/runtime/framework.md` · `docs/architecture/runtime/context-manager.md` · `docs/architecture/runtime/plugin.md` · `docs/architecture/harness/harness.md` · `docs/architecture/plugins/progressive-skill.md` · `docs/architecture/roadmap/future-work.md`

## 1. 背景

四项缺口的共同根因：harness 早期以"能跑通"为目标搭起最小循环，把运行时鲁棒性问题留到了后面。四项与现有抽象一一对应、互不交叉：

- **回合内工具并行** → `run-loop.ts` 工具执行段（串行 for 循环）
- **上下文压缩转默认 + 顺序修复** → `create-agent.ts` / `create-generic-agent.ts` 默认装配 + `run-loop.ts` shape/beforeModel 相对位置
- **运行中插话** → `run-loop.ts` 循环结构 + `agent-options.ts` 入参
- **Skill 双域 + 显式调用** → `plugin-progressive-skill/` 发现与工具入口

内部落地顺序：**① 工具并行 → ② 上下文压缩（默认 + 顺序修复 + 结构化摘要）→ ③ 插话 → ④ Skill 双域**。每组独立可验收。

本里程碑刻意不做：可配置压缩策略编排 UI、跨 run 持久化 steering 队列、技能市场/远程技能拉取、工具并行细粒度资源配额与限流。

## 2. 当前代码事实（baseline `220a7012` 已核对）

1. **工具执行串行**：`run-loop.ts:232-257` 用 `for` 循环逐个 `yield* executeOne()`。多个工具之间无并发。
2. **Tool 接口无执行模式声明**：`core/src/tool.ts` 只有 `{ name, description, inputSchema, execute }`，无 `executionMode` / `readOnly`。
3. **shape 在 beforeModel 之前，预算只覆盖 thread.messages**：`run-loop.ts:82-86` 先 shape 后注入，整形器看不到注入内容。已在 `context-manager.md` 记录为"预算对注入是瞎的"。
4. **默认上下文管理器是透传**：`create-agent.ts:63` 默认 `passthroughContextManager()`；`create-generic-agent.ts:151` 未传 `contextManager`。五种实现就绪但未接上。
5. **摘要是自由文本**：`summarizingContextManager` 默认摘要器产出纯文本，无结构化分区。`SummarizingOptions.summarizer` 有注入点。
6. **删/改消息统一过 `repairToolPairs`**：sliding-window / token-budget / summarizing 三种裁剪后修复悬空配对。
7. **runLoop 单层 maxSteps 循环**：`run-loop.ts:57` 的 `for (let step = 0; step < opts.maxSteps; step++)`，无外层 follow-up 循环，无中途消费新输入的环节。
8. **AgentRunOptions 不含 steering 入口**：`agent-options.ts` 的 `AgentRunOptions` = `{ signal, maxSteps, stream, maxForceContinues, runId }`。
9. **技能单域、无显式调用**：`progressive-skill.ts` 的 `root` 单值；tools 只有 `skillLoadTool`；无 `/skill:name` 入口，无 `disable-model-invocation`。
10. **技能元数据来自 gray-matter**：`cache.ts` `SkillMeta` = `{ name, description, dir, skillMdPath, bodyOffset }`。
11. **插件钩子点固定**：`fireBeforeModel` / `fireBeforeTool` / `fireAfterTool` / `onRunMessage` / `onRunComplete` 等。M22 不新增钩子类型。

## 3. 第一性原则

### 3.1 并行只对"可安全并发"的工具开

收益真实（多个只读检索可同时跑），但前提是工具间无顺序依赖、无共享可变状态。并行能力由工具自己声明，框架按声明调度。默认 `"serial"` = 零行为变化。

### 3.2 并行执行保持 tool_result 顺序

并发收集结果后，按原 `tool_use` 下标顺序写回 tool_result（非完成先后），保证配对不变量。中断时已完成的结果照常落账。

### 3.3 压缩默认生效 + 预算覆盖最终 payload

(a) 通用 Agent 装有效的默认上下文管理器（token 预算 + 摘要兜底）。
(b) 修复"预算对注入是瞎的"：shape 与 beforeModel 调序，让整形看到最终 payload。注入物标记为高优先级保留区，压缩只发生在可压缩的历史区。

### 3.4 摘要从自由文本升级为结构化分区

五槽位：目标 / 约束 / 进度 / 关键决策 / 下一步。多次压缩间槽位可累积/覆盖。用已有 `SummarizingOptions.summarizer` 注入点替换默认实现。

### 3.5 插话是"循环每步去队列取新输入"

进程内消息队列 + 循环每步 drain。区分 steering（step 边界注入，下一次模型调用就带上）和 follow-up（当前任务跑完后新轮输入）。steering 消息同样进预算口径。

### 3.6 技能双域 + 显式调用

双域发现（全局 + 项目，项目域同名覆盖全局域）。`/skill:name` 显式入口绕过模型自由裁量。`disable-model-invocation` 标记的技能不进模型索引。

## 4. 目标

1. 回合内工具并行：concurrent 工具并发执行，tool_result 按原序写回，默认行为不变。
2. 通用 Agent 默认装上有效上下文管理器（token 预算 + 摘要兜底）。
3. 修复整形顺序/预算盲区：整形对最终 payload 做总量保证。
4. 默认摘要升级为结构化五槽位分区。
5. 运行中插话：steering 消息可在 run 途中入队，循环每步消费。
6. 技能双域发现 + `/skill:name` 显式调用 + `disable-model-invocation`。

## 5. 非目标

- 不做可配置压缩策略编排 UI
- 不做跨 run 持久化 steering 队列（本期进程内、单 run 生命周期）
- 不做技能市场/远程技能拉取/技能版本管理
- 不做工具并行资源配额、限流、优先级调度
- 不动账本/投影/supervisor 等执行层之外的抽象

## 6. 实施分组

### P1 — 回合内工具并行

**P1.1** `core/src/tool.ts` — Tool 接口加 `executionMode?: "serial" | "concurrent"`，默认 `"serial"`。`"concurrent"` = 只读、无副作用、可与同回合其他 concurrent 工具同时跑。

**P1.2** `framework/src/run-loop.ts:230-257` — 串行 for 循环改为按模式分批：

```
toolUses = 本回合 tool_use[]
按出现顺序，连续 concurrent 聚成并发批，serial 各自成单元素批
for each batch in order:
  if batch.length == 1: interrupted = yield* executeOne(...)   // 旧路径
  else:
    results = await Promise.all(batch.map(call => runOneCollect(...)))
    按原 tool_use 下标顺序写回 thread（tool_result）
    按原序 yield 事件
    interrupted = 任一批内工具被中断
  if interrupted: break
```

**P1.3** `framework/src/execute-one.ts` — 提取 `runOneCollect`：执行单个工具，返回 `{resultBlock, events, interrupted}`，不 yield（供 Promise.all 内用）。现有 `executeOne` generator 保持为串行路径。

**P1.4** 中断语义：并发批中途 abort → 已 resolve 的落账，未完成的按 abort 处理，批次返回 interrupted=true，外层 break。

### P2 — 上下文压缩转默认 + 顺序修复 + 结构化摘要

**P2.1** `harness/src/create-generic-agent.ts:151` — createAgent 调用补 `contextManager`：

```ts
contextManager: pipeContextManagers(
  toolResultTruncator({ maxCharsPerResult: 4000 }),
  summarizingContextManager({ triggerAt: 100000, keepRecent: 10, summarizer: structuredSummarize }),
)
```

`create-agent.ts:63` 全局默认保持 passthrough。

**P2.2** `framework/src/run-loop.ts:82-86` — 调序为 beforeModel → shape：

```
injected = plugins.fireBeforeModel(thread.messages)
finalMsgs = contextManager.shape(ctx, injected, { preserve: <注入物标记> })
model.stream(finalMsgs)
```

`ContextManagerContext` 加可选 `preserve?: PreserveHint` 字段。`PreserveHint` = `{ ranges: Array<{ start: number; end: number }> }`，标记 messages 数组中不可裁剪的索引区间。shape 实现检查 preserve，压缩时跳过这些区间、只压可压缩区。`repairToolPairs` 继续兜底。

**P2.3** `framework/src/context-managers/summarizing.ts` — 新增 `structuredSummarize` 实现 `SummarizingOptions.summarizer` 注入点，prompt 让模型按五槽位产出。缺槽位留空不报错。`defaultSummarize` 保留为库内可选。

### P3 — 运行中插话 / steering

**P3.1** `framework/src/agent-options.ts` — `AgentRunOptions` 加 `steering?: SteeringQueue`：

```ts
interface SteeringQueue {
  drain(): Message[];
}
```

**P3.2** `framework/src/run-loop.ts` — 每步模型调用前 drain：

```
pending = opts.steering?.drain() ?? []
if pending.length: thread.messages.push(...pending)
```

Steering 消息经 beforeModel → shape 管线进入预算口径。

**P3.3** 外层 follow-up 循环骨架：现有 step 循环外包 `loop { ... }`，内层跑完后检查 `opts.followUp?.drain()`。无 follow-up → 单轮结束（等价现有行为）。followUp 队列留骨架，steering 为主路径。

### P4 — Skill 双域 + 显式调用

**P4.1** `plugin-progressive-skill/src/progressive-skill.ts` — `root` 改为 `roots: [globalRoot, projectRoot]`。`cache.ts` `loadSkillIndexWithMtimeCache` 扫多 root 合并，后者覆盖前者同名。缓存按 root 维护。

**P4.2** `cache.ts` — `SkillMeta` 加 `disableModelInvocation?: boolean`。`renderIndex` 过滤掉 disabled 技能。

**P4.3** `/skill:name` 显式入口 — plugin 导出 `findSkillByName(name)` 函数，绕过模型裁量直接按名加载（含 disabled 技能）。`skillLoadTool` 仍服务模型自动调用。

## 7. 验收标准

- **P1**：concurrent 工具同回合并发执行（耗时≈max 非 sum）；tool_result 顺序与 tool_use 一致；未声明工具行为逐字节不变；并发批中途 abort 已完成结果落账、整批 interrupted。
- **P2**：通用 Agent 默认非 passthrough；"历史压到预算线但注入超量"场景下 finalMsgs 在窗口内（注入保留、历史被压）；多轮压缩后摘要保持五槽位结构。
- **P3**：run 途中入队 steering 消息，下次模型调用 finalMsgs 含该消息且 run 未重启；steering 计入预算总量；无 steering/follow-up 时行为与改前一致。
- **P4**：全局 + 项目双域技能均被发现，项目域同名覆盖全局域；disabled 技能不出现在注入索引、模型调不到；`/skill:name` 能显式 load disabled 技能全文。
- **全局**：`packages/framework`、`packages/core`、`packages/harness`、`packages/plugin-progressive-skill` 既有测试全绿；新增各项单测覆盖正/反/边界。

## 8. 风险与权衡

- **工具并行副作用误标**：默认 serial、concurrent 须显式声明且 review 把关；文档明确 concurrent = 只读无副作用。
- **整形顺序改法 B 的注入保留**：注入物若过大本身就超预算，整形只能压历史区到 0。缓解：注入侧体积自律（记忆快照/技能索引各有上限）。
- **结构化摘要模型遵从度**：prompt 强约束 + 解析容错（缺槽位留空），必要时校验重试一次。
- **runLoop 重构回归面**：无 steering/follow-up 路径必须逐字节等价旧行为，以现有测试为基线。
- **双域就近覆盖歧义**：覆盖语义写进文档。

## 9. 落地后文档同步

- **P1** → 回填 `runtime/framework.md`（runLoop 工具执行段：串行→按模式分批并发）；更新 core Tool 接口描述。
- **P2** → 回填 `runtime/context-manager.md`：删"默认透传"改为"通用 Agent 默认装配 X"；"预算对注入是瞎的"改写为"已修复 + 修复后顺序图"；摘要从"自由文本"改为"结构化五槽位"。同步 `harness/harness.md`。
- **P3** → 回填 `runtime/framework.md`：runLoop 从单层 for 改为外层 follow-up + 内层 step，补 steering 队列与每步 drain。
- **P4** → 回填 `plugins/progressive-skill.md`：单域→双域，补 `/skill:name` 与 `disable-model-invocation`。
- 四项全落后 → `roadmap/future-work.md` M22 条目从方向降级为"已落地，详见对应现状页"。
