# 依赖注入

本页说明这个仓库怎么把具体实现装配进业务代码：依赖方向、用到的几种注入手法、组装点在哪，以及什么算注入漏洞。

## 范围

覆盖：依赖方向的原则、当前代码里的注入手法（端口与适配器、函数式策略、工厂加缺省、注册表分派、组合根）、判断准则、红旗信号。

不覆盖：各模块自己的接口语义（见对应功能页）、跨进程契约规则（见 [跨进程契约规则](./../e2e-contract-rules.md)）、DB 类型链（见 [DB 类型链规则](./../db-typesafe-rules.md)）。

## 实现文件

- `apps/backend/src/bootstrap/features.ts` — 组合根：所有端口、服务、后端的装配与接线
- `apps/backend/src/bootstrap/services.ts` — 进程级基础设施（数据库、设置、MCP 管理器、ops store、飞书注册表）
- `apps/backend/src/main.ts` — 启动顺序与优雅退出
- `apps/backend/src/app.ts` — Elysia app 组装：路由、错误处理、鉴权守卫
- `apps/backend/src/server.ts` — Bun.serve 与 Elysia 的 WebSocket 接线
- `packages/message/src/chat-model.ts` — 最小的模型端口
- `packages/ai/src/{api-registry,index}.ts` — API 注册表与 provider 工厂
- `packages/agent-contract/src/backend.ts` — AgentBackend 端口与后端注册表
- `apps/backend/src/features/agent-run/execution-types.ts` — 执行服务收到的函数式策略
- `apps/oh-my-agent/src/core/runtime/create-runtime.ts` — oma 侧自己的装配入口

## 依赖方向

依赖箭头指向内层：`packages/message` 只出窄接口（`ChatModel.stream()`、`Tool`），不知道任何 provider 存在；`packages/ai` 是唯一的 provider 实现层；`apps/backend` 的 feature 依赖端口，不依赖别的 feature 的实现。

判断准则只有一条：**业务函数体里不该出现具体实现**。要新建什么，就在组装点建好再传进去。

## 注入手法

**端口与适配器。** 多数 feature 是同一个形状：`domain.ts`（纯类型）、`ports.ts`（存储边界）、`service.ts`（业务，工厂函数）、`adapter-sqlite.ts`（实现）、`http.ts`（路由）、`index.ts`（barrel）。不是每个都齐——`agent-context` 没有路由文件，`artifact` 与 `mcp` 的适配器分别是 `adapter-fs.ts`、`adapter-file.ts`。

**函数式策略。** 需要业务侧决定、实现侧不知道的东西，用函数注入，而不是塞一个接口。例：`resolveWorkspace`（走哪个目录）、`dispatchRun` / `injectSteer` / `isLive` / `isInflight`（打破对话与执行之间的循环依赖）、`schedule(expr, fn)` 与 `startExecution`（Workflow 触发）、`onLog`（脚本节点日志）、`onRunCommitted` / `onRunFailed`（终态钩子）、`persistRunEvent`。

**工厂加合理缺省。** 可选依赖给默认值：执行服务的若干 deps 是可选的，`ContextBudget` 的触发比例有默认值。测试里只覆盖关心的那一两个。

**注册表分派。** 后端种类是一个注册表，装配时填、查表时用；`packages/ai` 的 API 实现也是注册表——加一种协议就是加一个文件加一次注册，不改调用方。

**组合根。** `installFeatures()` 是唯一装配点，`createBackendServices()` 造进程级基础设施，`main.ts` 只负责顺序与信号。`idGen` 也是注入的，测试里可以换成可预测实现。

## 什么不算漏洞

- 路由实例（`new Elysia()`）、HTTP server（`Bun.serve`）、进程级 store 在各自模块里创建：它们是模块的基础设施，不是业务协作者。
- 惰性工厂（`new CliSetupProvisioner()` 这类作为默认参数）虽然写在组合根文件里，但实例化发生在被调用时，可接受。

## 红旗信号

- 业务函数体里出现具体实现的构造：比如在 feature 内 `new OmaBackend(...)`，或者直接调 `Bun.cron` 而不是用注入进来的 `schedule`。
- 为了传一个值而把整个服务塞进另一个服务：先问这个值能不能直接传函数。
- 同一个能力出现两套注入路径：一条注入、一条模块级单例，早晚不一致。
- 端口上出现只有一个实现、且未来也不会有第二个的方法——那多半不需要端口，直接传函数更好。

## 不变量

1. 依赖箭头向内，`packages/message` 不知道任何具体实现。
2. 业务协作者在组合点装配；模块自己创建的是路由、server、进程级 store 这类基础设施。
3. 一个能力只有一条注入路径。
4. 加一种后端种类或 API 协议 = 加实现加注册，不改调用方。
