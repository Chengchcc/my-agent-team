# backend

整个系统里唯一的有状态后端服务,基于 Bun 运行。它对外暴露一套 HTTP/SSE API,管理 agent 的生命周期、承载多方会话、编排 agent 的执行(run),并负责把每个 agent 的实际计算调度到独立的 runner 进程里。Web 控制台、Lark 机器人等所有上层 surface 最终都通过它来读写状态、发起运行、订阅事件。

## 它负责什么 / 解决什么问题

后端是系统中持久化状态的中心。所有需要长期保存或跨请求共享的东西都收敛在这里:

- **Agent CRUD 与身份**:创建、查询、更新、归档 agent,管理每个 agent 的模型配置(provider / model / baseURL)、权限模式、最大步数,以及 SOUL / USER / memory 这类身份内容。删除时会清理对应的 workspace 与事件数据。
- **会话(conversation)**:一个会话是若干成员(人或 agent)共享的消息账本(ledger)。后端负责账本的追加、成员管理、按成员投影历史,以及 @mention 触发其他 agent 接力的编排,并对单个会话上锁以约束并发。
- **运行编排(run)**:把一次输入变成一次 agent 运行,跟踪 run 与 attempt 的状态,限制全局并发,支持取消、resume(审批后继续)以及基于事件日志的崩溃后重新发现(rediscover)。
- **Runner 进程池**:每个 agent 的真实执行跑在独立的 runner daemon 进程里,后端通过 Unix socket 与其通信,本身不在主进程内执行 agent 逻辑。
- **事件流 / SSE**:run 与会话的事件以事件日志为准源,通过 SSE 实时推送给订阅方;run 过程中产生的消息会被增量投影回会话账本,使多方进度即时可见。
- **运行时观测(ops)**:汇总 run 诊断、健康状态、成本/insights、trace 与 surface 状态,供控制台的观测面查询,也提供服务端取消/恢复运行的能力。

## 关键构成 / 怎么组织的

代码按特性分域组织在 `src/features/` 下,每个域内部遵循端口-适配器(ports & adapters)结构:`domain.ts` 定义实体与规则,`ports.ts` 声明依赖接口,`service.ts` 是纯业务逻辑,`adapter-sqlite.ts` 用 SQLite 实现持久化端口,`http.ts` 把服务暴露成路由。现有的域包括 `agent`、`conversation`、`run`、`thread-projection`、`runtime-ops` 和 `lark-bot`。

组合根是 `src/main.ts`。它在这里加载配置、打开 SQLite 数据库、构造各个域的适配器与服务,并用闭包把跨域的协作(例如 agent 删除时清理 events、会话触发 run、run 完成后投影回账本)接在一起,最后组装出 HTTP 路由并启动服务。这种"装配集中在一处、各域之间只通过端口和注入的回调交互"的方式,是这个后端最核心的组织原则。

运行的真正执行不在后端进程内。`features/run` 里的 `RunnerRegistry` 负责管理 runner 进程:开发环境用 `DevRunnerRegistry` 直接 spawn runner daemon 并通过 Unix socket(`runner-protocol`)连接;生产环境用 `ProdRunnerRegistry`,按约定的 socket 路径(`/run/runners/<agentId>/runner.sock`)解析已有的 daemon。`RunSupervisor` 在事件日志之上跟踪每次 run,提供 `onRunEvent` / `onRunComplete` 钩子,`main.ts` 借此把 run 期间的消息逐条投影进会话账本、累积 @mention 与 todo 快照,并在 run 结束后统一触发被 @ 到的 agent。

事件以事件日志为单一准源(`event-log` 包,落在独立的 `events.db`)。run 与会话的 SSE 端点都从事件日志读取并推流,会话账本则作为面向订阅者的可读缓存。Lark 集成由 `lark-bot` 域负责:它为开启了 Lark 的 agent 拉起独立的 lark-bot 进程,并通过 `with-lark-orchestration` 把这套生命周期挂到 agent 服务上。

HTTP 层在 `src/http/router.ts`,用正则匹配路径分发,所有业务路由都经过 `withAuth` 校验。主要路由族有 `/api/agents`(含 `/identity`、`/lark/setup`)、`/api/runs/<id>`(`/cancel`、`/events`、`/stream`、`/resume`)、`/api/conversations/<id>`(`/messages`、`/members`、`/events`、`/start-new`)、`/api/ops/*`,以及一个无需鉴权的 `/health`。服务器用 `Bun.serve` 启动,并把 `idleTimeout` 设为 0 以支撑长连接的 SSE。

## 怎么跑起来

开发模式会先构建依赖的工作区包,再用 Bun 直接跑入口:

```
bun run dev
```

其它脚本:`bun run build`(tsc 编译)、`bun run test`(bun test)、`bun run typecheck`、`bun run lint`。

配置在 `src/config.ts` 的 `loadConfig` 里从环境变量读取。两个必填项:`BACKEND_AUTH_TOKEN`(API 鉴权 token,缺失即启动失败),以及 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`(用于自动生成会话标题等)。常用可选项:`BACKEND_PORT`(默认 3000)、`BACKEND_HOST`(默认 127.0.0.1)、`BACKEND_DATA_DIR`(默认 `./.backend-data`,数据库与 workspace 都落在这里)、`BACKEND_WORKSPACE_ROOT`、`BACKEND_TEMPLATE_DIR`、`BACKEND_MAX_CONCURRENT`(全局并发上限,默认 8),以及一组心跳/回收/超时参数 `BACKEND_HEARTBEAT_INTERVAL_MS`、`BACKEND_HEARTBEAT_TIMEOUT_MS`、`BACKEND_CANCEL_GRACE_MS`、`BACKEND_REAPER_INTERVAL_MS`、`BACKEND_STEP_STALL_TIMEOUT_MS`。另外 `RUNNER_ENV`(`dev` / `prod`)决定 runner 与 lark-bot 用开发还是生产的 registry。

## 依赖与对接

后端依赖一组工作区内部包:`@my-agent-team/core`、`event-log`、`runner-protocol`、`runtime-observability`、`conversation`、`framework`、`harness`、`agent-spec`、`adapter-anthropic` 等,并用 Bun 内置的 `bun:sqlite` 做持久化。对外,它向 runner daemon(经 Unix socket)与按 agent 拉起的 lark-bot 进程下发工作,向 Web 控制台等 surface 提供 HTTP/SSE 接口,并对接 Anthropic 模型 API。
