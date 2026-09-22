# Oma Runtime

一句话：本页是 oma 运行时的权威描述。oma 是仓库自研的 CLI 执行引擎，有 print / json / rpc / tui 四种模式；产品侧只 spawn 它的 rpc 模式，每个 Run 在子进程内由 `createOmaRuntime()` 组一个 per-Run Runtime（模型与工具循环、内存 SessionStore、工具表、插件、审批），Run 结束即销毁，上下文续接靠 CLI 自己的 session 文件。

## 范围

覆盖：四种模式、per-Run 状态与 seed、每轮模型收到的内容、模型与 provider 的接线方式、Runtime 拥有的能力清单、TUI 的三个回合驱动、TUI 输入层的补全契约、事件与终态映射。

不覆盖：工具清单与超时旋钮（见 [Oma Tools](./oma-tools.md)）、插件与 HITL 细节（见 [Oma 插件与 HITL](../plugins/oma-plugins.md)）、compaction 算法（见 [Compaction](./compaction.md)）、模型目录与凭证（见 [模型与 Provider](./models.md)）、契约与四个 adapter（见 [Agent Backend](../execution/agent-backend.md)）。

## 实现文件

- `apps/oh-my-agent/src/cli/args.ts` — `CliMode`、usage、`--tools/--session/--model/--permission/--read-only`
- `apps/oh-my-agent/src/main.ts` — 四模式分发
- `apps/oh-my-agent/src/modes/{print-mode,json-mode}.ts`、`modes/rpc/rpc-mode.ts`、`modes/tui/tui-mode.ts`
- `apps/oh-my-agent/src/core/runtime/create-runtime.ts` — `createOmaRuntime` facade
- `apps/oh-my-agent/src/core/runtime/run-runtime.ts` — `assembleRunRuntime`（工具表 / 模型接线 / 权限门 / 委派栈）
- `apps/oh-my-agent/src/core/runtime/{loop-input,prompt,prompts}.ts` — seed、Meta 渲染、系统提示
- `apps/oh-my-agent/src/core/runtime/agent-loop-runner.ts` — loop 实体（`runModelTurnLoop`）
- `apps/oh-my-agent/src/core/loops/*`、`core/goals/*`、`core/plans/*` — TUI 的三个回合驱动
- `apps/oh-my-agent/src/modes/tui/{tui-commands,tui-slash,tui-format}.ts` — 命令、补全注册、路径显示
- `packages/tui/src/autocomplete.ts` — 补全 provider 契约
- `apps/oh-my-agent/src/protocol/{transport,mapping}.ts` — child 侧 wire 与事件映射

## 四种模式

| 模式 | 用途 |
|---|---|
| `print` | 一次 Run，stdout 只有最终文本 |
| `json` | 一次 Run，stdout 是全部事件的 JSONL，加恰好一行 outcome |
| `rpc` | 每 Run 一次 execute，之后可接 steer / abort / resolve_approval；stdout 是 response / event / outcome |
| TUI | 交互式终端，独立启动，不是 backend 的执行路径 |

产品走 rpc：严格 LF JSONL，stdout 只承载协议。print 与 json 的审批管道是"全拒"（`denyAllApprovals`）且没有 `askHandler`——它们无人可问。

## per-Run 状态

```text
SessionStore   = 单次 Run 的执行缓存（消息 + compaction 条目）
                 每次装配新建，sessionId == runId，close() 即销毁
seed           = 投影历史（source=product_history）
               + 恰好一条 Meta（source=meta）
               + 本次驱动输入（source=prompt 或 follow_up）
```

- 同 Run 内 retry 复用同一个 store，输入批次不重复追加；steer 追一条消息。
- follow-up 是新 Run：新子进程、新 store、重新 seed。
- `productEntryId` 让同一条规范 Message 在一个 Run 内幂等；compaction 追加 `CompactionEntry`，原始消息条目不删。

## 每轮模型收到什么

```text
system prompt   不写 SessionStore，来自 run 快照（Run 创建时冻结）
Meta 用户消息    写 SessionStore，source=meta，每 Run 恰好一条
驱动输入         写 SessionStore，source=prompt 或 follow_up
投影历史         写 SessionStore，source=product_history
```

**Meta 的真实内容**只包含两类东西：

- 插件的 Meta 段（技能索引用 `Skills` 段，任务列表用 `Current Tasks` 段）；
- 一个 `Workspace` 段：workspace root、工作目录、操作系统、当前模型。

日期、记忆摘要、分支上下文都**不在** Meta 里，它们在系统提示（`buildSystemPrompt` 的 workspace 上下文与 memory 摘要）。Meta 由 OmaSession 自己渲染，驱动输入的文本原样保留。

系统提示的来源顺序：run 快照给了就用它；没给（独立 CLI 会话）时由 `readWorkspaceSystemPrompt(cwd)` 组装（SOUL/USER + AGENTS.md 链 + 知识索引）。技能根同理：run 快照给了就用它，否则回落到扫描工作区 `.oma/skills`。

## 模型接线

- 模型解析按 Run 的 `modelId` 走（canonical `<provider>/<model>`，会过别名表）；解析不到是硬错误，不做静默回落。
- 单次模型调用有硬死线，默认 300 秒（`OMA_MODEL_TIMEOUT_MS` 可覆盖）：卡住的 provider 不能把 Run 永远留在 running，超时等于 Run 失败，且不自动重试。
- 自动重试只覆盖瞬时错误（网络、限流、过载、5xx）；鉴权与 4xx 不重试。
- 上下文预算（compaction 的 limit 与 trigger）来自 run 模型的 `contextWindow`。provider 报上下文溢出或静默超长时，走一次 compaction 恢复。
- 凭证只经 env 进子进程，不进 SessionStore、不进事件、不进日志。

细节见 [模型与 Provider](./models.md)。

## Runtime 拥有什么

- 模型与工具循环（`agent-loop-runner.ts` 是唯一的 loop 实体；`agent-loop.ts` 只是 `createOmaSession()` 的组装层）。
- 原生工具与 MCP 挂载（清单见 [Oma Tools](./oma-tools.md)）。
- retry、compaction、工具结果按需修剪（`prune` 旋钮显式开启）、任务列表（会话级 `.oma/todo/<scope>.json`）。
- 插件：代码加载、信任矩阵、marketplace（见 [Oma 插件与 HITL](../plugins/oma-plugins.md)）。
- HITL 审批：permissionMode 三态门控 `ask` / `auto` / `deny`，超时 deny（同上）。
- stream rules：读 `<workspace>/.oma/rules/*.md`，在 assistant 文本流上匹配，命中即丢弃本轮输出、注入提醒后同轮重试。
- 工具失败提醒：失败的 tool result 前置一段 `<system-reminder>`。
- TUI 的三个回合驱动（下一节）。

## TUI 的回合驱动（goal / loop / plan）

三个驱动都能在用户不再输入时继续推进会话，因此**互斥**：任一驱动认领本回合后，其余两个被顶掉并回显顶掉了谁。`/goal` 与 `/plan` 各有主开关（`.oma/settings.json` 的 `goalEnabled` / `planEnabled`，缺省等于开）。

| 驱动 | 入口 | 形态 |
|---|---|---|
| loop | `/loop [次数\|时长] [--while\|--until <cmd>] [prompt]` | 每轮结束后按 `loopAction` 处置，然后重投同一个 prompt |
| goal | `/goal`、`/guided-goal` | 一个跨轮次的目标，由模型用工具声明完成 |
| plan | `/plan`、`/plan-review` | 只读调查 → 起草计划 → 人工复审后实施 |

**迭代间动作**由 `loopAction` 决定：`prompt`（重投）、`compact`（先摘要）、`reset`（先开新会话）、`ralph`（构建循环）。限额支持轮数与时长（`10m`、`1h30m`），裸整数是轮数，除非后面跟了时间单位。

**条件门**（`--until` / `--while`）跑一条 shell 命令，**退出码是唯一权威，stdout 忽略**：退出 0 且 `--until` 就是满足，退出 1 是唯一表示"条件为假"的状态，退出码大于 1（127 找不到命令、2 语法错）或没有退出状态表示条件本身坏了——按错误停止并说明原因，绝不读成"干完了"。条件跑在独立进程里（`cd` 不会移动会话的 cwd、stdin 关闭、有 120 秒死线、继承 OS 沙箱、并发排空管道以防刷屏条件塞满管道）。求值期间收到 Esc 则裁决作废。

**构建循环**（`loopAction: "ralph"`）用工作队列 `.oma/plan.md`（`- [ ]` 待办、`- [x]` 完成）。队列是**项目级**的：每轮都是新会话，按会话存放会每轮拿到空文件而丢掉进度。

**plan 的草稿**写在 `.oma/plans/<sessionId>.md`（会话级）。只读由 write / edit 工具守卫强制（只放行该路径）；**bash 仍只靠提示词约束**，这是诚实记录的缺口。

驱动协议提示词走**隐藏输入通道**（`[goal-mode]` / `[ralph-loop]` 前缀）：只送给模型，不回显也不落会话文件——落过，`/resume` 会把它们回放成幽灵用户气泡。loop 的普通重投 prompt **不走**这个通道：那段文字本来就是用户输的，会照常回显成一个正常回合。

会话切换（`/resume`、`/new`）不会让任何驱动自动继续：loop 关闭，plan 与 goal 恢复为 paused。loop 自己发起的 `/new`（`--keep-loop`）是唯一例外，否则每轮重开会话的循环会在第一轮就结束自己。

## TUI 输入层：补全与路径显示

补全契约在 `packages/tui/src/autocomplete.ts`：

```ts
interface AutocompleteProvider {
  triggerCharacters?: string[];
  getSuggestions(
    lines: string[], cursorLine: number, cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<{ items: AutocompleteItem[]; prefix: string } | null>;
  applyCompletion(lines, cursorLine, cursorCol, item, prefix)
    → { lines: string[]; cursorLine: number; cursorCol: number };
  shouldTriggerFileCompletion?(lines, cursorLine, cursorCol): boolean;
}
```

两个设计要点：

1. provider 拿的是行数组加光标坐标，返回候选集加**正在匹配的前缀串**。`prefix` 决定接受补全时替换哪一段，所以补全可以发生在行中间而不破坏前后文。
2. `CombinedAutocompleteProvider` 按优先级分流：行首或行中的 `/token` 走 slash 命令（命中后交给该命令自己的 `getArgumentCompletions`）；`@` 前缀走文件引用；其余走路径前缀补全。`signal` 让昂贵 provider 在光标移开后立刻中止。

同一文件里另有 2 秒 TTL 的缓存，那是**状态栏的 git 状态**（分支名加脏文件数）用的，不是目录列表缓存——`setBusy()` 每次回车都会读它，同步跑 `git status` 会卡住渲染。

TUI 的路径显示统一走 `formatWorkspace(root, maxLen = 48)`：`$HOME` 先折成 `~`，超预算则**中间省略**（从中间向外丢整段，保留头锚点与尾部段名，单段太长时退化为 `head…tail`）。项目 worktree 的 `<projectId>.<slug>` 尾巴很容易把行撑爆，省略是默认行为。

## 事件与终态

子进程把 Runtime 事件包成 `RunEventEnvelope` 发到 stdout；adapter 用自己的映射（`packages/adapter-oma-agent/src/event-mapper.ts`）转成 `BackendEvent` 与 `BackendRunOutcome`，child 侧的 `protocol/mapping.ts` 是另一份独立实现——两份不是同源，见 [Agent Backend](../execution/agent-backend.md)。`agent_end.status` 映射为 completed / failed，stopped 映射为 aborted。outcome 是唯一终态权威。

## 不变量

1. 每个 Run 一个子进程、一个 Runtime，child 在写出 outcome 后自行退出。
2. Runtime 不访问产品数据库；输入只有 Run 快照、工作区与投影历史。
3. `runId` 是唯一执行身份，SessionStore 不跨 Run，每次装配新建。
4. rpc 模式下 stdout 只承载协议，stderr 只做日志。
5. 每 Run 恰好一条 Meta 用户消息；retry 与 steer 不重新渲染 Meta。
6. 产品工具的权限与事实归 Product Backend，child 只经 MCP 调用。
7. project-scope 插件代码永不进 rpc 模式加载。

## 已知缺口

- plan 模式的只读只覆盖 write / edit，bash 仍可写——靠提示词约束，没有强制。
- 三个驱动的主开关与状态都在 TUI 侧；backend 起的 Run 不涉及这些模式。
- compaction 摘要失败不会判 Run 失败，但失败只写调试日志，终端上没有任何可见信号。

## 相关页

- [Agent Backend](../execution/agent-backend.md) — 契约、四个 adapter、wire
- [Oma Tools](./oma-tools.md) — 工具表、超时、记忆
- [模型与 Provider](./models.md) — provider 注册、models.yml、凭证
- [Compaction](./compaction.md) — 摘要与切点
- [Oma 插件与 HITL](../plugins/oma-plugins.md) — 插件与审批链
