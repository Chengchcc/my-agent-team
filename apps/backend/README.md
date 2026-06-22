# backend

基于 Bun 的有状态后端服务。暴露 HTTP/SSE API，管理 agent 生命周期、承载多方 conversation、编排 agent 执行（run），把每个 agent 的计算调度到独立 runner 进程。Web 控制台和 Lark bot 通过它读写状态、发起运行、订阅事件。

## 它做什么

- **Agent CRUD 与身份**：创建、查询、更新、归档 agent。管理 model 配置（provider / model / baseURL）、permission mode、maxSteps，以及 SOUL / USER / memory 等身份内容。
- **Conversation**：多个 member（人或 agent）共享的 conversation ledger。负责 ledger 追加、成员管理、@mention 触发、conversation 并发锁（ConversationLock）。
- **Run 编排**：把输入变成一次 agent run，跟踪 run/attempt 状态，限制全局并发，支持取消、resume，以及基于 EventLog 的崩溃后 rediscover。
- **Runner 进程池**：每个 agent 在独立 runner daemon 进程执行，后端通过 Unix socket 通信。Agent 逻辑不在主进程内运行。
- **SSE 推送**：conversation 的 ledger SSE 是用户可见输出的唯一通道。assistant 消息经 `onRunMessage` 直写 ledger，前端按 `messageId` upsert。run 执行细节走 EventLog（仅非 message 事件）。
- **运行时观测（ops）**：run 诊断、健康状态、trace 与 surface 状态，供控制台查询。

## 代码组织

代码按 feature 分域在 `src/features/` 下，每域 ports & adapters 结构：`ports.ts` 定义接口，`service.ts` 是纯逻辑，`adapter-sqlite.ts` 是 SQLite 实现，`http.ts` 暴露路由。域包括 `agent`、`conversation`、`run`、`thread-projection`、`runtime-ops`、`issue`、`orchestrator`、`lark-bot`。

组合根 `src/main.ts` 加载配置、打开 DB、构造各域 adapter 和 service，用闭包把跨域协作接在一起（agent 删除清理 events、conversation 触发 run、onRunMessage 直写 ledger、onRunComplete terminal 写入），最后组装 HTTP 路由。各域之间只通过 interface 和注入的 callback 交互。

Runner 管理：`RunnerRegistry` 负责管理 runner 进程。开发环境用 `DevRunnerRegistry` spawn runner daemon 经 Unix socket 连接；生产环境用 `ProdRunnerRegistry` 按 socket 路径解析已有 daemon。`RunSupervisor` 跟踪每次 run，提供 `onRunMessage` / `onRunEvent` / `onRunComplete` 回调。

## 怎么跑

```bash
bun run dev
```

配置在 `src/config.ts`，从环境变量读取。必填：`BACKEND_AUTH_TOKEN`、`ANTHROPIC_API_KEY`。常用：`BACKEND_PORT`（默认 3000）、`BACKEND_HOST`（默认 127.0.0.1）、`BACKEND_DATA_DIR`、`BACKEND_MAX_CONCURRENT`（默认 8）、`RUNNER_ENV`（`dev` / `prod`）。

## 依赖

依赖内部包：`@my-agent-team/core`、`event-log`、`runner-protocol`、`runtime-observability`、`conversation`、`framework`、`harness`、`adapter-anthropic`。持久化用 `bun:sqlite`。对 runner daemon 经 Unix socket 下发工作，对 Web/Lark surface 提供 HTTP/SSE，对接 Anthropic API。
