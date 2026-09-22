---
title: Agentic Workflow
description: 工作流 DSL 与校验规则、JSON-Logic 子集、路由与合并语义、backend 执行路径、cron 触发与事件流
tags: [workflow, backend]
---

# Agentic Workflow

Workflow 是本仓库的编排层：一份 `*.workflow.json` 定义一张节点图，引擎按图推进，执行记录落在数据库里。编排身份是 workflow execution，不是 Agent Run——agent 节点派发的是普通 Agent Run。

## 范围

覆盖：DSL 与校验规则、JSON-Logic 子集、路由与合并语义、backend 执行路径（drive / agent / script / human / retry / cancel / recover）、事件总线与 SSE、cron 触发、Artifact 引用、agent 侧的定义读写面。

不覆盖：Web 编辑器与画布交互（见 [Web 端](./surfaces/web.md)）、Agent Run 自身的生命周期（见 [Product Backend 总览](./backend/overview.md)、[Run 输出与实时更新](./runs/output-and-live-updates.md)）、oma 子进程内部那套 `core/orchestrate/` 脚本工具（它与本 DSL 无关，见文末「两条独立路径」）。

## 实现文件

- `packages/workflow/src/types.ts` — DSL 领域类型：五类节点、IO 提示、schema、retry、triggers
- `packages/workflow/src/parse.ts` — `parseWorkflow` 校验：单 start、id 正则、各类型必填、边端点、可达性、未知算子、输出字段引用、拓扑环
- `packages/workflow/src/json-logic.ts` — JSON-Logic 子集求值器与算子白名单（13 个）
- `packages/workflow/src/graph.ts` — `CompletionRecord.routedTo` 冻结、`routeOutgoing`、`mergeInputs`、`topoSort`
- `packages/workflow/src/engine.ts` — `computeNext`：纯函数步进（首个 start、any-of join、首个 ready end 即终态、idle 检测）
- `packages/workflow/src/schema.ts` — JSON-Schema 子集校验器，节点输入输出用它
- `packages/workflow/src/editor/{graph-model,layout}.ts` — 分层布局，Web 画布消费
- `apps/backend/src/features/workflow/service.ts` — drive 循环、节点执行、重试、取消、恢复、human 原子 claim
- `apps/backend/src/features/workflow/node-runners.ts` — script 节点 runner：`WORKFLOW_SCRIPTS_ENABLED` 门 + 进程沙箱
- `apps/backend/src/features/workflow/adapter-sqlite.ts` — 四张表的 drizzle 适配器
- `apps/backend/src/features/workflow/{trigger-scheduler,event-bus,definition-events,dry-run,mcp,http}.ts`
- `apps/backend/src/features/artifact/{domain,service,adapter-fs,http}.ts` — `artifacts://` 引用与文件存储
- `apps/backend/src/bootstrap/features.ts` — 组装：MCP server、节点 runner、服务、触发同步、showcase 播种

## DSL

`WorkflowDefinition = { version: 1, id, meta?, input?, triggers?, nodes, edges }`，`version !== 1` 直接拒绝（`types.ts:110-119`）。

节点 id 限 `^[a-zA-Z0-9_-]+$`，类型只认 `start` / `end` / `agent` / `script` / `human`（`parse.ts:24-31`）。各类型的必填项：

- `end` 必须给 `status`。
- `agent` 必须有 `agentId`，或者 `model` 与 `prompt` 都给（`parse.ts:121-122`）；可选 `repo`。
- `script` 必须有 `code`；`runtime` 只被解析，沙箱实际恒为 bun；`timeoutMs` 可选。
- `human` 有 `question` / `form` / `timeoutMs`。

输入提示 `input` 是 `InputField[]` 数组（不是对象），`type` 限 `string | number | boolean | artifact`（`types.ts:6-11`）；`output` 同理。`inputSchema` / `outputSchema` 是 JSON-Schema 子集，支持 `type`、`properties`、`required`、`additionalProperties`、`items`、`enum`、`minimum`、`maximum`、`minLength`、`maxLength`、`minItems`、`maxItems`，没有 `$ref`、`oneOf`、`pattern`（`types.ts:38-52`）。

`retry` 可以是数字，也可以是 `{maxAttempts, intervalMs, backoff}`。`triggers` 目前只有一种：`{type: "cron", cron: <五段表达式>, enabled?}`，DSL 是触发器的唯一真相源。

`parseWorkflow` 会拒绝这些：重复 id、start 不是恰好一个、边的端点不存在、从 start 不可达的节点、`when` 里出现白名单外的 JSON-Logic 算子、`node.output.<field>` 引用了不存在的输出字段、以及拓扑环。

## JSON-Logic 子集

白名单 13 个算子：`var`、`==`、`!=`、`>`、`>=`、`<`、`<=`、`in`、`and`、`or`、`not`、`if`、`!!`（`json-logic.ts:9-23`）。

未知单键对象在 parse 期就报错。这一步是必须的：如果放过去，它会落进「普通对象当数据」的分支并恒为真，把审批门变成无条件放行（`parse.ts` 的 collectUnknownOps）。

几个语义细节：`==` / `!=` 是 `JSON.stringify` 深比较，键顺序敏感；`if` 只接受严格三元；`var` 支持 `"a.b"` 和 `["a.b", default]` 两种写法。

求值域只有来源节点的 output 和 store（`graph.ts:66-72`）——想跨节点取值，先写进 store。

## 路由、join 与合并

**路由在完成瞬间冻结。** `routeOutgoing` 在节点完成时算出目标，写进 `CompletionRecord.routedTo`；引擎之后只读它，永不重算（`graph.ts:4-11,85-108`、`engine.ts:22-23`）。

**`nextNode` 覆盖条件路由**：source 节点的 output 里带 `nextNode: string` 时，该值必须是这个节点某条出边的目标，否则抛 `WorkflowRouteError`（`graph.ts:20-24,97-104`）。实现上任何节点类型都能用它。

**join 是 any-of**：任一上游 routed 到本节点，本节点即可运行，互斥分支汇合时互不等待（`engine.ts:39-45`）。AND-join 没有实现——DSL 里也没有表达它的标记（`packages/workflow/README.md` 仍写着 AND-join，那是错的）。

**首个 end 即终态**：ready 集合里出现 end 就立即返回终态，取定义序的第一个（`engine.ts:48-52`）。

**合并顺序**：`mergeInputs` 依次合并 trigger、store、以及所有已完成节点的 output，按完成顺序、晚完成者胜出，返回每个 key 的来源；`nextNode` 与 `__proto__` / `constructor` / `prototype` 被排除在数据面之外（`graph.ts:116-143`）。human 答案走 HTTP 进来时同样过滤这四个 key（`service.ts:689-699`）。

**没有 ready 也没有终态**就是 `idle`，壳层抛 `stuck: no ready nodes and no terminal`（`engine.ts:53`、`service.ts:582`）。

## 执行路径

四张表：`workflow_execution`、`workflow_node_run`、`workflow_pending_human`、`workflow_execution_event`。

状态机：execution 是 `running | waiting_human | success | failure | custom`；node_run 是 `running | waiting_human | completed | failed`；pending_human 是 `pending | resolved`。终态映射 `exitStatus()`：`failure → failure`，`success → success`，其余落 `custom`（`service.ts:118-122`）。

`startExecution` 起一个异步 drive 后立刻返回行；`runToCompletion` 是给它 await 的同步版本，主要给测试用。`triggeredBy` 默认 `manual`，cron 触发时是 `cron:<expr>`。

`drive` 从数据库里已有的 node_run 重建 completions 起步，循环「`computeNext` → 顺序执行 ready → 记录完成」，最后回读 execution 的 store（`service.ts:561-610`）。ready 列表是**串行 await** 的，同一批多个 ready 不是并发 fan-out。

**agent 节点**：conversation id 是 `workflow:<executionId>:<nodeId>`（origin 为 workflow），内联 agent 走 `default` 成员加 `modelOverride`。node_run 里已经存了 `runId` 就重连轮询而不重复触发；重试时先清 runId 再起新 run。轮询上限 600 秒，每秒一次，终态判据是 status 落在 `completed|failed|aborted|commit_failed|timeout`，或者 terminalResult 已存在（`service.ts:429-446`）。

**输出抽取**：取最后一条 assistant 文本，剥掉代码围栏后取第一个 JSON 对象；解析不出而节点又声明了 output 提示就报错。prompt 里会注入 outputSchema 与「只回 JSON」的约束。

**schema 重试**在 workflow service 里，不在 run harness：`runNodeWithRetry` 按 `retry` 算次数与间隔，失败时把上一次的错误塞回 prompt 再发一轮（`service.ts:307-328,502-517`）。重试耗尽即节点 failed，execution 落 failure。

**script 节点**走 `deps.nodeRunners.script.run`，runner 先查 `WORKFLOW_SCRIPTS_ENABLED`——没开的话每个 script 节点必失败。执行本身在 `runInSandbox` 里：默认超时 60 秒（不是 spec 里写的 30 秒），隔离参数 `noNetwork` 加 `denyReadDirs`（默认拒 `dataDir` 与 cwd 下的 `.env`）。脚本拿到的 ctx 就是合并后的 input 本身，没有 store、没有 log、没有宿主对象——`packages/workflow/src/node-runtime.ts` 里那个带 store/log 的 `ScriptContext` 是死契约，照它写脚本会崩。

**human 节点**：读 ready input 里的 `question`/`form` 覆盖 DSL 的静态声明，把表单映射成 ask_question 的形状，写 pending_human、把 execution 置 `waiting_human`、发 `human_task_requested`，然后 drive 暂停（节点不完成）。

**human 恢复**：`resolveHumanTask` 要求 execution 处于 `waiting_human`、pending 存在且未 resolved，过滤控制面 key 后重新路由，再用条件 UPDATE（`status='pending'`）原子 claim；claim 失败说明另一路已经抢到，返回 409。胜者写 node_run completed、execution 回到 `running`、异步续 drive。批量接口逐条返回 ok/error，不整体失败。

**取消**只对 `running` 与 `waiting_human` 生效，而且两条路径的 exit 不一样：`waiting_human` 取消立即终态化，exit 是 `aborted`；`running` 取消只置内存标记，由 drive 或轮询循环观察到后抛 `WorkflowCancelledError`，最终 exit 是 `failure`。

**失败**：节点异常先写 node_run failed 加 error、发 `node_failed`，再往外抛；`runWithCatch` 把 execution 落 failure。节点失败不参与图路由，没有 per-node 的失败边。

**恢复**：启动时 `sync()` 触发同步后 `recover()` 重驱所有 `running` execution；`waiting_human` 的不重驱，等用户 resolve。

## 事件

事件类型：`execution_started`、`node_started`、`node_agent_started`、`node_agent_completed`、`script_log`、`node_completed`、`node_failed`、`human_task_requested`、`store_write`、`execution_terminal`。每次 emit 同时进内存总线并 fire-and-forget 落库，落库失败不阻塞 drive。

`store_write` 虽然在代码里，但生产路径永远不会触发：写 store 的 `storeApiOf` 没有任何调用方，store 恒为空对象。

SSE 端点是 `GET /api/workflow-executions/:id/events`，顺序是「先订阅 → 重放持久历史 → 再直播」——先订阅才能保证重放期间的事件不丢；execution 已终态则重放完直接结束，`finally` 里必 unsubscribe。事件总线收到 `execution_terminal` 即终止流。

## 触发

调度器从 `<dataDir>/workflows/` 读 `*.workflow.json`，逐文件 `parseWorkflow`。单个文件坏掉只跳过加日志，不影响别的文件，也不影响启动。

`sync()` 先停掉所有旧句柄再重建，同一 `definition.id` 的第二个文件会被跳过（否则旧句柄泄漏）；坏 cron 表达式只跳过那一条 trigger。

fire 时每次都重新读定义并按 id 查找，所以改文件不需要重新注册即可生效。`enabled: false` 不注册。同一个 workflow 的并发 tick 直接丢弃（per-workflow single-flight）。fire 内部任何异常都被吞掉并记日志——未捕获的 rejection 会杀掉整个 backend 进程。

启动时若 workflows 目录为空，会从 `<resources>/workflow-showcase` 拷入示例定义。

## Artifact

地址形如 `artifacts://<folder>/<filename>`，存在 backend dataDir 下的文件系统里，元数据带 size、mimeType、encoding、updatedAt 与来源（runId / conversationId / agentId）。

路径安全是两层的：`parseArtifactUrl` 只接受 `^artifacts://([^?]+)$`，`splitPath` 拒绝绝对路径、盘符、`..`、`.` 和通配符；fs 适配器再做 `resolve()` 加分隔符的前缀校验（挡掉 `../artifacts-evil` 这种同名前缀绕过），`list(folder)` 在**任何 fs 访问之前**先拒越界目录。

落盘时写一个 `<file>.meta.json` 记录 encoding、来源与更新时间，读的时候优先用它决定按 utf8 还是 base64 解。

REST 是 `GET /api/artifacts`（可按 folder 过滤）、`GET /download?url=`、`GET /:url`、`POST /`、`DELETE /remove?url=`、`DELETE /:url`（删除幂等，恒返回 `{ok:true}`）。

MCP 侧由 product-tools server 暴露 `artifact_upload` 与 `artifact_download`。`artifact_download` 在预授权清单里，`artifact_upload` 故意不在——它能写后端存储，要过权限门。

聊天里的引用是纯文本机制：composer 打 `@` 插入 `artifacts://` URL；markdown 渲染时 remark 插件把 `artifacts://` 转成链接，再由 `a` 渲染器换成 artifact 卡片。

**节点边界的校验比想象的松**：只对 `input`/`output` 提示里标了 `type: "artifact"` 的 key，且**值本身已经是 `artifacts://` 开头的字符串**时才查存在性；其它前缀或非字符串一律跳过。检查发生在 start 节点、节点 input、节点 output 三处。

## agent 侧的定义读写面

定义文件在 `<dataDir>/workflows/*.workflow.json`，**在 agent workspace 之外**，所以文件工具够不着（会报 `path escapes workspace`）。

Agent 想读写定义只有一条路：内置的 workflow MCP server（SSE，绑 127.0.0.1）。它默认启用，只有 server 起来了才会往 workspace 的 `.mcp.json` 里注入 `workflow` 条目。

`workflow_read` 直接返回文件原文。`workflow_write` 先跑 `parseWorkflow`（非法即返错），但**不写文件**——它发出一个 definition `changed` 事件把定义推给编辑器，并在返回值里说明没有保存。未知工具名返回错误，不静默成功。

编辑器订阅 definition SSE：收到 `trigger="mcp"` 的提案时把它当未保存草稿（标 dirty、清 savedAt），收到 `trigger="save"` 才重新拉取并清 dirty；本地 dirty 时一律不覆盖用户的改动。真正的落盘只有 HTTP PUT 一条路。

## 两条独立路径

oma 子进程里还有一套自己的脚本编排（`apps/oh-my-agent/src/core/orchestrate/`，`workflow_run` 工具、`.oma/workflow` 持久化），TUI 的 `/workflow` 用的是它。那是 Run 级、子进程内部的能力，与本文的 DSL **无关**，两边不要互相引用。

## 不变量

1. 引擎是纯函数，不做 I/O、不看时钟。路由在节点完成瞬间冻结，之后任何 store 写入都翻不动它。
2. join 是 any-of。当前 DSL 没有表达 AND 的标记。
3. script 节点只经进程沙箱执行，而且是 opt-in（`WORKFLOW_SCRIPTS_ENABLED`）；沙箱是进程边界不是 fs jail，宿主对象刻意不进沙箱。
4. agent 节点的输出必须过 `outputSchema`，失败时带着错误反馈重试，重试耗尽即节点失败、execution 落 failure。
5. 节点失败逐节点记录并广播，execution 以 failure 终态；不伪造 output。
6. human 的完成是原子 claim，条件 UPDATE 决定唯一赢家，输家 409。
7. 定义落盘前必须过 `parseWorkflow`——PUT 与 MCP write 在同一条信任边界上。

## 已知缺口

- human 节点的 `timeoutMs` 被解析但从未实施，pending human 永不过期。
- 并行 fan-out 没有实现，ready 列表串行 await。
- agent 节点的 `repo` 字段进了 `NodeContext`、依赖也接好了，但没有调用方，agent 节点不会切到该 repo 的 worktree。
- `workflowRef.repo` 被忽略，定义只从本地目录读，没有 git loader。

详细清单见 [`../roadmap.md`](../roadmap.md)。
