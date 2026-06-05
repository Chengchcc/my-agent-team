# 架构概览

## 目标

从第一性原理构建一个小型 agent 栈：调用方提供 messages，模型流式输出 assistant 内容，工具按需执行，结果回喂，直到模型结束 turn。

## 四层架构

```text
L4 Harness    有观点的产品层：内置 tools + system prompt + 权限策略
L3 Framework  装配层：createAgent 式 API，组合 model + tools + plugins
L2 Runtime    运行内核：messages → model → tools → messages
L1 Protocols  类型契约：Message / ChatModel / Tool
```

## Milestone 交付

| Milestone | 交付 |
|---|---|
| M1 | `@my-agent-team/core`（L1+L2）+ `@my-agent-team/test-helpers` |
| M2 | `@my-agent-team/adapter-anthropic` + `@my-agent-team/tools-common` + `@my-agent-team/cli` |
| M3 | `@my-agent-team/framework`（L3） |

## 架构文档

- [01-glossary.md](./01-glossary.md) — 术语表
- [02-framework.md](./02-framework.md) — 框架层设计
- [03-plugin.md](./03-plugin.md) — Plugin 扩展机制详解
- [04-checkpointer.md](./04-checkpointer.md) — Checkpointer 持久化与中断
- [05-context-manager.md](./05-context-manager.md) — ContextManager 上下文管理
- [06-harness.md](./06-harness.md) — Harness 的定义
- [07-harness-vs-framework.md](./07-harness-vs-framework.md) — Framework vs Harness 边界

## 设计原则

1. **No protocol without proven need** — 协议字段只为已发生的痛点加，不为想象需求加
2. **No deep imports** — 跨包只能从 index.ts 进
3. **Composition over hooks** — 能用 JS 函数嵌套解决的，不加框架钩子
4. **State belongs to caller by default** — messages 由调用方持有，runtime 原地推进
5. **Layer downward dependency** — L4→L3→L2→L1，反向 = bug
6. **AsyncIterable is the event stream** — 不重新发明 EventBus / Observer
7. **One concept, one name** — 同一事物全项目同一称呼
8. **Rule of three** — 第三次重复出现才提取抽象

## Runtime 契约

`run(model, tools, messages, options)` 是一个 async generator。流式 yield assistant 快照，把完成的 assistant 消息和 tool 结果推进调用方持有的 `messages` 数组，串行执行 tool，无 tool_use 或达 maxSteps 时停止。

Model 抛错向上传播。Tool 抛错转成 `is_error: true` 的 `tool_result`，让 LLM 能从错误上下文继续。
