# Tool Wave Spec — `runTurnUsecase` 内的并发工具调度

> **Status**: Draft (design-only, no code)
> **Owner**: TBA
> **Tracks**: `domain/turn-runner.ts` 改造、`tools` 扩展 `conflictKey` 补全、可选 wave 事件、TUI 视觉分组
> **Cross-refs**: 与 [sub-agent-spec.md](./2026-05-24-sub-agent-design.md) 共享 `task` 工具的 `conflictKey`;与 [plan-mode-spec.md](./2026-05-24-plan-mode-design.md) 共享白名单概念

---

## 0. 目标与非目标

### 0.1 目标
1. 在 `runTurnUsecase` 的单个 round 内,把 LLM 给出的 N 个 tool calls 按 `conflictKey` **冲突分组**,**无冲突 wave 内并发,有冲突跨 wave 串行**。
2. 对外可观察行为(事件名、payload、`tool.error` 不中断 turn、10 轮上限)**完全保持兼容**。
3. 提供全局开关 `parallelTools`(默认 `true`)与回滚路径(关掉退化为现状串行)。
4. 补全所有内置工具的 `conflictKey` 与 `readonly` 声明,补齐 MCP 注入工具的默认 `conflictKey`。
5. 提供可选的 `wave.start` / `wave.end` 事件,用于 TUI 视觉分组与 trace 审计。

### 0.2 非目标
- ❌ 不引入跨 round 重排(round 边界是模型决策边界,不动)。
- ❌ 不引入有向依赖图("A 必须在 B 后"),冲突仅对称。
- ❌ 不做 per-call 取消(abort 仍是 turn 级)。
- ❌ 不引入历史成功率驱动的动态调度(MVP 静态)。
- ❌ 不为 wave 状态做持久化/checkpoint。
- ❌ 不实现 per-tool timeout middleware(单独立项,见 §11)。

---

## 1. 概念模型

> Tool wave = round 内的"冲突分组"。一个 round 的 N 个 calls 被切成 1..N 个 wave,wave 内并发,wave 间严格串行。

### 1.1 冲突的定义

给定一个 round 的 calls `C = [c1, c2, ..., cN]`(按 LLM 响应顺序),每个 call 解析:

```
toolName    := c.toolName
readonly    := tool.readonly === true
conflictKey := tool.conflictKey?.(c.input) ?? `tool:${toolName}`
```

**两次 call 冲突,当且仅当**:
- 都不是 `readonly`,**且**
- `conflictKey` 严格相等(字符串比较)。

**Readonly 工具与任何工具都不冲突**。这是契约,不是执行期检查 —— 工具自己声明 `readonly: true` 就承诺无副作用。

### 1.2 Wave 划分(贪心保序算法)

```
remaining = list(C)             # 保留 LLM 给出的顺序作为 stable tiebreaker
waves = []
while remaining:
  wave = []
  takenKeys = new Set()         # 本 wave 已占用的非 readonly conflictKey
  next = []
  for c in remaining:
    if c.readonly:
      wave.append(c)
    elif c.conflictKey not in takenKeys:
      wave.append(c)
      takenKeys.add(c.conflictKey)
    else:
      next.append(c)
  waves.append(wave)
  remaining = next
```

---

## 2. 架构分层

| 层 | 新增 / 修改 |
|---|---|
| `application/ports/tool.ts` | **改**:`conflictKey` 已存在,无需改;补充 JSDoc 强制约定(纯函数、稳定输出) |
| `application/usecases/run-turn.ts` | **改**:`runTurnUsecase` 入参新增 `parallelTools?: boolean`、`eventOrder?: 'completion' \| 'submission'`、`maxWaveConcurrency?: number` |
| `application/contracts/` | **改**:可选新增 `wave.started` / `wave.completed` 事件类型,默认不发(配置开关控制) |
| `domain/` | **新** `wave-scheduler.ts`:纯函数 `partitionWaves(calls, descriptors): Wave[]`(可单测) |
| `domain/turn-runner.ts` | **改**:主循环改为 wave 调度;事件 yield 行为见 §4.2 |
| `extensions/tools/` | **改**:补全 `ask_user_question`、`write` 的 `conflictKey`;归一化 `text_editor` / `write` 的 `path` 键 |
| `extensions/mcp/` | **改**:注入工具时附加默认 `conflictKey`(`mcp:${server}:${toolName}`) |
| `extensions/frontend.tui/` | **可选**:`FinalToolCallView` 外包 `<WaveGroup>`,把同 wave 的 tool 视觉分组 |
| `extensions/dataplane/` | **改**(若启用 wave 事件):增加 2 条桥 |

---

## 3. 工具声明矩阵(必须补全)

| 工具 | `readonly` | `conflictKey(input)` | 状态 |
|---|---|---|---|
| `read` | ✅ | — | 已声明 |
| `grep` / `glob` / `ls` | ✅ | — | 已声明 |
| `web_search` / `web_fetch` | ✅ | — | 已声明 |
| `bash` | ❌ | `'bash:global'` | 已声明,保守串行所有 bash |
| `text_editor` | ❌ | `` `file:${normalize(input.path)}` `` | **改**:加 `path.resolve` 归一化 |
| `todo_write` | ❌ | `'todo:global'` | 已声明 |
| `ask_user_question` | ❌ | `'ask:global'` | **新增** |
| `write` | ❌ | `` `file:${normalize(input.path)}` `` | **新增**(与 `text_editor` 共享键空间) |
| `task`(sub-agent) | ❌ | `` `subagent:${input.subagent_type}` `` | **新增**(详见 [sub-agent-spec.md](./2026-05-24-sub-agent-design.md)) |
| MCP 注入工具(默认) | ❌ | `` `mcp:${server}:${toolName}` `` | **新增**(`mcp` 扩展统一注入) |
| `exit_plan_mode`(若启用 plan mode) | ✅ | `'mode:global'` | **新增**(详见 [plan-mode-spec.md](./2026-05-24-plan-mode-design.md)) |

**`conflictKey` 设计原则**(测试需断言):
1. 字符串、纯函数、相同输入相同输出。
2. 命名空间前缀分隔(`bash:` / `file:` / `todo:` / `ask:` / `mode:` / `subagent:` / `mcp:`),避免跨域碰撞。
3. 路径必须 `path.resolve(input.path)` 归一化,确保 `./a` 与 `a` 与绝对路径算同键。
4. 抛错时 fallback 到 `'tool:<name>'` + warn,不能让坏输入炸 turn。

---

## 4. 调度协议(turn-runner 内部)

### 4.1 主循环

```
for round = 0 .. maxRounds-1:
  resp = await provider.invoke(...)
  if resp.toolCalls.empty: break

  waves = parallelTools
    ? partitionWaves(resp.toolCalls, toolDescriptors)
    : resp.toolCalls.map(c => [c])              # 关掉 = 退化为 N 个单 call wave

  for waveIndex, wave in enumerate(waves):
    if abortSignal.aborted: yield 'turn.failed'; return
    if eventsEnabled: yield 'wave.started' { round, waveIndex, size: wave.length }
    yieldsBuffer = scheduleWave(wave)            # §4.2
    for ev in yieldsBuffer: yield ev
    if eventsEnabled: yield 'wave.completed' { round, waveIndex, ok: ... }
    if abortSignal.aborted: yield 'turn.failed'; return

  appendAssistantAndToolResultsToHistory(...)
```

### 4.2 事件顺序的两种语义(必须二选一)

| 模式 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A. completion order** | wave 内 N call 同时 `tool.start`,谁先完成谁先 `tool.end` | 真实反映并行 | 事件序不稳定 → snapshot 测试难 |
| **B. submission order** | wave 内 N call 同时 `tool.start`,但 `tool.end` 按 LLM 提交顺序 yield(用 mailbox 缓冲) | 序确定 → 测试稳定 | 慢的卡住快的 |

**默认 `'completion'`,提供选项 `eventOrder: 'submission'` 用于测试与回放场景。**

### 4.3 单 wave 调度

```
scheduleWave(wave):
  semaphore = new Semaphore(maxWaveConcurrency ?? Infinity)
  events = []                                    # 序列化的输出 buffer

  promises = wave.map(async call => {
    await semaphore.acquire()
    try:
      events.push({ type: 'tool.start', call })  # submission 序保证
      result = await hooks.onToolCall(call)
      return { ok: true, call, result }
    catch err:
      return { ok: false, call, err }
    finally:
      semaphore.release()
  })

  if eventOrder === 'completion':
    for p as it resolves: emit tool.start (deferred? or前置) + tool.end/error
  else:
    await Promise.allSettled(promises)
    for r in results in submissionOrder: emit tool.start + tool.end/error

  return events
```

> 实现细节里有个微妙点:`tool.start` 的 yield 时机。**两种模式下,`tool.start` 都按提交序在 wave 入口处一次性 yield 完毕**,然后再按各自模式 yield `tool.end`/`tool.error`。这样保证"用户看到的开始顺序"始终稳定,只有结束顺序会变。

### 4.4 与 `onToolCall` hook 的关系

`onToolCall` 仍是 `sequential` hook(每个 call 自己内部串行经过中间件链,如 permission)。**所谓"并行"是对多个 call 各自独立 dispatch onToolCall**,不改 hook 模式。permission 的 30s 阻塞 = 该 call 的 promise pending,wave 内其他 readonly call 正常完成。

---

## 5. Invariants(测试断言)

### 5.1 `partitionWaves` 纯函数

1. `flatten(waves) === C`(顺序保留,只重分组)。
2. 同一 wave 内,任意两个非 readonly call 的 `conflictKey` 互不相同。
3. 跨 wave 同 `conflictKey` 的 call,墙时间偏序:前 wave 全部 `tool.end`/`tool.error` 后,后 wave 才 `tool.start`。
4. wave 数 ≤ N;wave 数 = max(同 conflictKey 出现次数) over 非 readonly call。
5. 全 readonly N 个 → 1 wave、N 并发。
6. 全同 conflictKey N 个 → N wave、完全串行(等价当前行为)。

### 5.2 事件流不变量

7. 同一 call 的 `tool.start` 严格在 `tool.end`/`tool.error` 之前。
8. wave 边界处:wave_k 的全部 tool 事件 ≪ wave_{k+1} 的任意事件(墙时间偏序 + yield 序)。
9. 即便 `parallelTools = true`,`tool.start` 的 yield 序列始终是 LLM 提交序(submission order)。
10. `tool.error` 的存在不影响后续 wave 调度(turn 不中断)。

### 5.3 `conflictKey` 契约

11. 所有内置工具调用 `conflictKey(input)` 返回相同输入相同输出。
12. `conflictKey` 抛错 → 视为 `'tool:<name>'` 并记 warn,turn 不崩。
13. `text_editor({ path: './a' })` 与 `write({ path: '/abs/a' })` 经 `path.resolve` 后 conflictKey 相同(同一文件互斥)。
14. MCP 工具 `mcp:srvA:fmt` 与 `mcp:srvB:fmt` conflictKey 不同 → 可并行。

---

## 6. 关键决策点(已决)

| ID | 决策 | 选择 | 理由 / 备选 |
|---|---|---|---|
| **D-1** | 默认开关 | `parallelTools: true` | 默认行为升级;关掉为保险回滚 |
| **D-2** | 事件顺序模式 | 默认 `'completion'`,可选 `'submission'` | 真实反映并行;测试用 submission 拿稳定快照 |
| **D-3** | `tool.start` yield 时机 | 始终按提交序在 wave 入口 yield 完毕 | 用户视觉"开始"序稳定 |
| **D-4** | Readonly 与有副作用是否互斥 | **不互斥** | 读不阻塞写、写不阻塞读;不做 MVCC |
| **D-5** | conflictKey 缺省值 | `'tool:<name>'` | 保守:未声明的工具按同名互斥 |
| **D-6** | `text_editor` 与 `write` 共享键空间 | 是,均为 `file:<resolved-path>` | 防同文件并发踩踏 |
| **D-7** | Path 归一化 | `path.resolve(input.path)` | 解决 `./a`/`a`/`/abs/a` 等价问题 |
| **D-8** | `bash` 全局串行 | 是,`'bash:global'` | 工作目录共享、env 共享、安全 |
| **D-9** | `ask_user_question` 全局串行 | 是,`'ask:global'` | 同时 2 个问题对用户糟糕 |
| **D-10** | `todo_write` 全局串行 | 是 | 状态机一致性 |
| **D-11** | `task`(sub-agent)按 type 串行 | 是,`'subagent:<type>'` | 同类型 sub 抢资源;不同类型可并发 |
| **D-12** | MCP 工具默认 conflictKey | `'mcp:<server>:<tool>'`,可被工具自定义覆盖 | 防同 server 同名工具误并 |
| **D-13** | `maxWaveConcurrency` 默认 | `Infinity`(MVP),接口先留 | IO 打爆是真实风险但低概率;先观察 |
| **D-14** | wave 事件是否默认发出 | **默认不发**;`emitWaveEvents: true` 显式启用 | 兼容现有事件契约;TUI/trace 按需开 |
| **D-15** | 失败隔离粒度 | wave 内 call 级 | 一个 call 失败 → `tool.error` + 其他正常完成 + turn 继续 |
| **D-16** | abort 生效粒度 | wave 边界 | 已 start 的 call 让其完成或丢弃(模式 A 决策点 D-17) |
| **D-17** | abort 时已 start call 的处理 | 后端 promise 仍跑完(底层 tool 自己看 signal),但 runner **丢弃**其 `tool.end` 事件 | 简化语义;tool 自己尊重 signal 才会真正快速取消 |
| **D-18** | `conflictKey` 抛错的策略 | warn + fallback `'tool:<name>'` | 已用文档化;运行时硬规则 |
| **D-19** | round 内重排是否允许 | 否,严格保序 | 避免与 LLM 期望的执行序错位 |
| **D-20** | parallelism 度量 | 通过 `wave.completed.size` 暴露;trace 可统计 wave 数 / 平均 size | 可观测性 |

---

## 7. Edge cases

1. **空 round**:`toolCalls.length === 0` → 不进入 wave 循环,turn 完成。
2. **全 readonly N 个**:1 wave、N 并发;wall-clock ≈ max(call.duration)。
3. **全同 conflictKey N 个**:N wave、完全串行;事件序与现状一致(回归测试)。
4. **混合**:`[read, write(/a), read, write(/a), bash]` → wave1 = `[read, write(/a), read, bash]`;wave2 = `[write(/a)]`。
5. **同 wave 一个失败**:`tool.error` 单独 yield,其他 `tool.end` 正常;turn 不中断。
6. **abort 在 wave 中部**:已 start 的 call 后端可能仍跑;runner 在 wave 边界终止;后续 wave 不调度;yield `turn.failed`。
7. **`conflictKey` 抛错**:fallback `'tool:<name>'` + warn。
8. **`readonly: true` 的工具实际改了文件**:策略层不防御,文档化为"工具的承诺"。
9. **Permission 阻塞**:wave 内 `write` 卡 permission 卡片 → readonly call 仍正常完成;permission 解除 → `write` 自然 `tool.end`。
10. **Path 归一化**:`text_editor({ path: './a.ts' })` 与 `write({ path: '/abs/a.ts' })` 经 resolve → 同 wave 互斥。
11. **MCP 同名不同 server**:`mcp:srvA:fmt` 与 `mcp:srvB:fmt` 可并行。
12. **`maxWaveConcurrency = 1`**:行为退化为完全串行;wave 划分仍成立。
13. **Wave 中所有 call 都是 readonly,但其中一个对同一文件读**:仍可并发(读不互斥)。
14. **同一 LLM round 重复 `task({ subagent_type: 'plan' })` 三次**:wave 划分得到 3 个 wave、串行(`conflictKey` 相同)。

---

## 8. 当前测试覆盖 & 建议新增

**当前覆盖** — 0 个文件(直接测 wave 调度)。

**新增:**

```
tests/domain/wave-scheduler.test.ts          # partitionWaves 纯函数:14 条 invariants 全覆盖
tests/domain/turn-runner-parallel.test.ts    # 集成:受控延迟 fake tool,断言 wall-clock 与事件序
tests/application/usecases/run-turn-parallel.test.ts  # 端到端 + abort + permission 阻塞
tests/extensions/tools/conflict-key.test.ts  # 每个工具的 conflictKey 契约 + path 归一化
tests/extensions/mcp/conflict-key.test.ts    # MCP 注入工具默认 conflictKey
tests/extensions/tools/event-order.test.ts   # eventOrder 'completion' vs 'submission' 行为差异
```

**Given/When/Then 样例(并行墙时间):**
> *Given* 4 个 readonly fake tool,每个 `await sleep(100ms)`,`parallelTools: true`,`eventOrder: 'submission'`。
> *When* 一个 round 调用这 4 个 tool。
> *Then* 整 round 墙时间 < 200ms(并行下界);`tool.end` 序列 = LLM 提交序;`turn.completed` 在 4 个 `tool.end` 全部 yield 后 yield。

**Given/When/Then 样例(失败隔离):**
> *Given* 同 wave 3 个 readonly tool,中间那个 `await sleep(50); throw`。
> *When* 执行该 wave。
> *Then* 1 个 `tool.error` + 2 个 `tool.end`;`turn.failed` **不**被 yield;下一 round 正常调度。

---

## 9. 分期里程碑

| 期 | 范围 | 验收 |
|---|---|---|
| **M1** | 纯函数 `partitionWaves` + 14 条 invariants 单测 | 单测全绿,turn-runner 不接入 |
| **M2** | turn-runner 接入,默认 `parallelTools: false` | 现有 `turn-runner.test.ts` 全绿;新 wave 集成测试也绿 |
| **M3** | `conflictKey` 矩阵补全(`ask_user_question` / `write` / `task` / MCP / `exit_plan_mode` 占位) | conflict-key 测试绿 |
| **M4** | 默认 `parallelTools: true`,dogfood 一周 | `tests/extensions/tools/event-order.test.ts` 绿;线上观察 |
| **M5** | wave 事件 + `maxWaveConcurrency` 安全阀 + TUI `<WaveGroup>` 视觉分组 | 端到端 |
| **M6** | trace 增加 wave 统计 | 可在 trace.show widget 看到 |

---

## 10. 故意 *不* 做的事

- ❌ 跨 round 重排:LLM round k+1 不会被合并到 round k 的 wave。
- ❌ 依赖图执行:无 "A → B" 偏序。
- ❌ Per-tool timeout:不在本 spec;留待 `tool-timeout-spec`。
- ❌ Per-call cancel:abort 仅 turn 级。
- ❌ 基于 ML 的动态调度:静态算法可推理。
- ❌ Wave 持久化:turn 结束即销毁。

---

## 11. 与其他 spec 的协同

- **sub-agent**:`task` 工具的 `conflictKey = 'subagent:<type>'` 落入本 spec 的调度协议。
- **plan-mode**:`exit_plan_mode` 的 `conflictKey = 'mode:global'`;plan mode 下白名单工具仍受 wave 调度。
- **per-tool timeout**(未启动):预留接口 `tool.timeoutMs?: number`,wave 调度对每个 call 加 `Promise.race([call, timeout])` 即可,本 spec 不实现。

---

## 12. DESIGN.md 落点

- **§2.1 `runTurnUsecase`** invariant 改写: "Tool calls within a round are partitioned into waves by `conflictKey`; calls within a wave run concurrently, waves run sequentially."
- **§2.5 Tool wave scheduling**(新节):落地 §1~§5 的内容。
- **§4.6 `tools`** 表格:补全 `ask_user_question` / `write` 的 `conflictKey`。
- **§9 Known-but-not-implemented**:删除 "Tool wave / parallel dispatch" 一条(timeout middleware 仍保留)。
