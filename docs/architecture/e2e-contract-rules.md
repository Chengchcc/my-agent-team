---
title: 跨进程契约规则
description: 在 backend、web、lark-bot 之间加字段或调接口前必读：契约真源地图、禁止写法与可执行门禁所在
tags: [conventions, rules]
---

# 跨进程契约规则

本页是跨进程与跨包契约（HTTP、SSE、react-query、环境变量、跨进程消息、模板变量）的动手前决策表与自检。它是[设计哲学](./design-philosophy.md)里「统一本体，不复制语义」在传输层上的可执行版：在 backend、web、lark-bot 之间加字段、调接口、消费 SSE、加查询、读环境变量之前，先过这张表。

## 范围

覆盖：触发器决策表、真源地图、自检、加新契约时的自问，以及可执行门禁在哪。

不覆盖：backend 内部的 DB 类型链（见 [DB 类型链规则](./db-typesafe-rules.md)）。

## 一句话根因

跨进程的契约一旦两端各写一份，编译器就看不见两边的关系：改一边另一边静默错位，`tsc` 不报错，`as` 把窟窿焊死。解法是每类契约只有一个真源，两端都从它推导。

## 动手前的决策表

| 当你要…… | 先停，去这里取真源 | 禁止 |
|---|---|---|
| 在 web 用一个后端返回的字段 | 改 backend 的返回类型，让它经 `App` 流过来 | 在 web 手写或扩一个 interface 接住它 |
| 调一个后端接口 | `client.api.*`（treaty，类型来自 `@chengchenccc/api-contract`） | `apiFetch<T>`、裸 `fetch` 加断言 |
| 消费一个 SSE 事件 | 在 `SSEEventMap` 里加或取 zod schema，用 `typedSource(url, map)` | `new EventSource` 加各自的 `JSON.parse` 与断言 |
| 拼一个 SSE 端点 URL | `sseEndpoints` 注册表加 `openSSE(name, params)` | 组件里手写 `/.../events` 模板串 |
| 加一个 `useQuery` / `useMutation` | `features/<x>/queries.ts` 里写 `queryOptions(params)`，组件只调 hook | 组件内联 `queryKey:` / `queryFn:` |
| 读一个环境变量 | 共享 `envSchema` 加 `parseEnv()` | 各进程裸读 `process.env` |
| 跨进程传一个结构 | 提一个共享 zod schema，两端 import 后 parse | 一端写 interface，另一端 `as {...}` |
| 加一个状态值或枚举值 | 改共享单源（`as const` 或 `z.enum`），两端 import | 新文件重抄联合类型 |
| 读写一个 DB 的 JSON 列 | 定义 zod 双向 codec | `JSON.parse(row.x) as T` |
| 渲染一个模板 | 给变量一个固定类型，键与模板变量同源 | `Record<string, unknown>` 加字符串约定 |

## 真源地图

| 契约 | 真源 | 消费方式 |
|---|---|---|
| HTTP 请求与响应 | 后端 Elysia 的 `App` 类型，从 `apps/backend/src/app.ts` 导出、经 `@chengchenccc/api-contract` re-export | treaty 推导 |
| SSE 事件载荷 | `SSEEventMap`，值为 zod schema（`packages/api-contract/src/sse.ts`） | 后端 `sseEncoder<M>`，前端 `typedSource<M>` |
| SSE 端点 URL | `sseEndpoints` 注册表（路径模板绑定事件 map） | `openSSE(name, params)` |
| react-query 的 key 与参数 | `queryOptions(params)`，`params` 是唯一来源 | 组件调 hook |
| 环境变量 | `packages/config/src/env.ts` 的 `envSchema` | `parseEnv()`，一处解析 |
| 跨进程消息 | 共享 zod schema | 两端 import 并 parse |
| 枚举与状态 | 共享 `as const` 或 `z.enum` | 两端 import |
| oma 的 JSONL 协议 | `apps/oh-my-agent` 生成的 canonical fixture | `packages/adapter-oma-agent` 的测试消费 fixture |

## 写完自检

**可执行版在 `scripts/audit-contracts.ts`**，它跑在 CI 的第二环（`bun run audit:contracts`）。下面这些是人工检查用的宽松版本，与门禁不完全一致：

```bash
# 组件不得手抄类型或直连 fetch —— 当前 0 命中
grep -rn "apiFetch<\|as AgentRow" apps/web/src

# 组件不得内联 queryFn —— 当前 0 命中（只查 queryFn，不查 queryKey）
grep -rn "queryFn:" apps/web/src/app apps/web/src/components

# SSE 只许在 typedSource 里 new EventSource —— 当前 0 命中
grep -rn "new EventSource" apps/web/src

# 环境变量只许经 parseEnv —— 有白名单，见门禁脚本
grep -rn "process\.env\." apps/backend/src apps/web/src apps/lark-bot/src | grep -v "\.test\.ts"

# 跨进程不得裸断言 —— lark-bot 侧有存量基线
grep -rn "as {\|as Record<" apps/lark-bot/src
```

门禁里三处零容忍是 `queryFn:`、`new EventSource`、`.mcp.json` 三条断言；带存量基线的有两处：lark-bot 的四条裸断言（`ingest`、`bootstrap`、`bindings-sqlite`、`render`），以及环境变量的三条桥（backend 的 `config.ts`、`infra/oma-command.ts`、测试 harness）——那些地方本来就要读原始 env，属于合法出口。

**别用宽 grep 当门禁。** `queryKey:` 与 `client.api.` 在外层组件里大量出现（`invalidateQueries` 的 key、SSR 页面里的 treaty 调用），宽 grep 会永远红灯，然后被人关掉。

门禁通过时会打印一行摘要，说明哪些检查是零容忍、哪些还在基线里。

## 加新契约时的自问

1. 它属于哪个已有的领域对象？
2. 它的真源应该放在哪个包？两端怎么从真源推导，而不是各写一份？
3. 半年后如果有人只改其中一端，编译器会拦住他吗？拦不住就是还没收敛好。

## 不变量

1. HTTP 的类型真源是后端的 `App` 类型，前端不手抄。
2. 全仓只有一处 `new EventSource`，URL 只从端点注册表来。
3. 组件的查询钩子是唯一入口，组件内不内联 `queryFn`。
4. 环境变量一处解析，桥接位置在门禁里白名单登记。
5. 跨进程结构两端共享一个 zod schema。
