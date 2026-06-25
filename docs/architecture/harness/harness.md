---
id: harness.harness
title: AgentSession — Agent 编排层
status: current
owners: architecture
last_verified_against_code: 2026-06-25
summary: "AgentSession 把 Framework 的 Agent + Checkpointer + PluginRunner + ContextManager 组成为一个有生命周期管理（prompt/continue/resume/abort）和自动化维护（retry/compaction）的运行时单元。"
depends_on:
  - runtime.framework
  - runtime.plugin
  - runtime.context-manager
used_by:
  - flows.e2e-web-message
  - flows.e2e-lark-message
  - flows.e2e-issue-lifecycle
  - backend.overview
---

# AgentSession

AgentSession 是 Agent 的运行时编排。它不是领域对象——它是已有领域对象的胶水，把构造、运行、事件分发、维护操作封装成一个类。Backend 直接创建 AgentSession 并调用 `prompt()`，Agent 在 Backend 进程内执行。

## 构造

```
AgentSession(config):
  → createAgent({ model, threadId, tools, plugins, checkpointer, contextManager, logger, systemPrompt })
  → agent.subscribe(#handleEvent)
  → 初始化 steer/followUp 队列 + retry/compaction 状态
```

构造参数：

| 参数 | 类型 | 来源 |
|------|------|------|
| `model` | `ChatModel` | Backend 从 agent DB row 构造 |
| `threadId` | `string` | `{conversationId}:{memberId}` |
| `tools` | `Tool[]` | Backend 创建（闭包持有 cwd、convPort 等上下文） |
| `plugins` | `Plugin[]` | `identityPlugin`, `ConversationContextPlugin`, `fsMemoryPlugin`, `progressiveSkillPlugin`, `taskGuardPlugin` |
| `checkpointer` | `Checkpointer` | 全局 `dataDir/checkpointer.db`，按 `threadId` 分区 |
| `contextManager` | `ContextManager` | `pipeContextManagers(toolResultTruncator, autoSummarize)` |

AgentSession 通过 `agent.subscribe()` 注册一个内部订阅者，在 Agent 发射每个事件时处理副作用：通知外部 listeners、检查 retry/compaction 条件、包装 `agent_end` 的 `willRetry` 字段。

## 生命周期

一次 run 的完整生命周期：

```
dispatch:
  session = new AgentSession({...})
  await session.prompt(input)
  session.dispose()

resume（工具触发 InterruptSignal 后暂停）:
  session = sessions.get(runId)
  await session.resume({ approved: true/false })
  // agent_end（非中断）后 dispose
```

Backend 维护 `Map<runId, AgentSession>` 以便 resume 时查找。Agent 被中断后 AgentSession 保持存活——只存在 `agent_end`（真正的结束，非中断）时才 dispose。

## prompt() 流程

```
prompt(text)
  ├── Agent 正在 streaming? → 消息放入 steer/followUp 队列 → return
  └── 非流式 → runAgentPrompt(messages)
      ├── agent.prompt(messages)
      ├── while (postRunNeedsContinue)
      │   ├── retryable error? → backoff → agent.continue()
      │   │   └── 当前 assistant message 的 MessageRevision.runStatus = "retrying"
      │   ├── overflow? → compact() → agent.continue()
      │   │   └── 当前 assistant message 的 MessageRevision.runStatus = "compacting"
      │   ├── threshold? → compact() → return
      │   └── queued messages (steer/followUp)? → agent.continue()
      └── return
```

## 内部订阅者

`#handleEvent` 处理 Agent 发射的每个事件：

```
#handleEvent(event):
  ├── message_start (user) → 从 steer/followUp 队列中移除对应文本
  ├── message_end → 通知外部 listeners
  │   ├── role=assistant → 记录 #lastAssistantMessage（供 post-run 检查用）
  │   └── terminal → 检查 retry/compaction 条件
  ├── agent_end → 包装 willRetry 字段 → emit
  ├── interrupted → 标记 run 暂停，等待 resume
  └── tool_execution_start/update/end → 透传给外部 listeners
```

## 事件

AgentSession 发射给外部 listener 的事件类型：

```typescript
type AgentSessionEvent =
  // Agent 核心事件（agent_end 被增强——加了 willRetry）
  | Exclude<AgentEvent, { type: "agent_end" }>
  | { type: "agent_end"; messages: Message[]; willRetry: boolean }

  // 队列状态变更
  | { type: "queue_update"; steering: string[]; followUp: string[] }

  // 上下文压缩
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason; result?; aborted; willRetry; errorMessage? }

  // 自动重试
  | { type: "auto_retry_start"; attempt; maxAttempts; delayMs; errorMessage }
  | { type: "auto_retry_end"; success; attempt; finalError? }
```

外部 listener 由调用方（conversation、orchestrator、cron）在 `startAgentRun` 时提供。不同调用方根据事件类型执行不同的持久化和推进逻辑——conversation 写入消息到账本、orchestrator 推进 Issue 状态机、cron 标记任务完成。

## compact()

上下文压缩——调用 LLM 将老消息总结为一段摘要文本，替换原来的消息前缀：

```
compact(customInstructions?)
  → checkpointer.load(threadId) → messages
  → 计算 token 用量，确定压缩边界（保留最近 N 条，summarize 前面的）
  → LLM summarize(messages[0..N-10])
  → summaryMessage = { role: "user", text: "[Earlier summary]: ..." }
  → thread.messages = [summaryMessage, ...messages[N-10:]]
  → checkpointer.save(threadId, thread.messages)
  → agent.state.messages 替换为新的消息列表
  → emit compaction_end
```

与 `autoSummarize`（contextManager 管道里的自动预防）的区别：`compact()` 是 overflow 后的修复操作或用户手动触发的显式操作——两者在不同层协作，不互相替代。

## 错误处理

| 场景 | 行为 |
|------|------|
| compact() 中 LLM 调用失败 | 保留原 messages，压缩放弃，日志告警 |
| retry 耗尽（3次） | `agent_end` 携带 error + `willRetry: false` |
| prompt() 期间 abort | `agent.abort()` 终止当前 run，跳过 post-run 处理 |
| overflow → compact → 再次 overflow | 停止，告警 |
| steer/followUp 在 retry 等待期间到达 | 保留在队列，retry 成功后注入 |

## 关联页面

- [Framework 运行循环](../runtime/framework.md)
- [上下文管理器](../runtime/context-manager.md)
- [运行时插件机制](../runtime/plugin.md)
- [Web 消息端到端](../flows/e2e-web-message.md)
- [ConversationContextPlugin](conversation-context-plugin.md)
