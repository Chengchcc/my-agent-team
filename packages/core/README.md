# @my-agent-team/core

定义 agent 系统最底层的协议类型，并提供一个极简的工具调用循环。整个仓库里所有跟"消息""模型""工具"打交道的代码，最终都对齐到这里的类型。

## 为什么需要它

一个 agent 系统里有很多角色：模型适配器、工具、对话框架、运行时、后端。如果每一层都自己定义"什么是一条消息""工具长什么样"，它们之间就无法拼装。`core` 的职责就是把这套词汇固定下来：消息、内容块、模型接口、工具接口。它故意保持很薄——没有任何运行时依赖（`package.json` 里 `devDependencies` 为空、无 `dependencies`），不绑定任何具体的模型厂商，也不掺杂权限、检查点、上下文裁剪这些上层关注点，那些都属于 `framework`。

可以把 `core` 理解成协议层：它规定形状，但几乎不规定行为。唯一的例外是 `run()`，一个最小可用的参考实现，证明这套协议确实能跑起来。

## 核心概念

**Message 与 ContentBlock。** 一条 `Message` 有 `role`（`"user" | "assistant" | "system"`）和 `content`。`content` 既可以是纯字符串，也可以是一个 `ContentBlock[]`。内容块有三种：`TextBlock`（文本）、`ToolUseBlock`（模型发起的工具调用，带 `id`/`name`/`input`）、`ToolResultBlock`（工具结果，通过 `tool_use_id` 回指那次调用，可带 `is_error`）。一轮对话就是这些消息的有序列表。

**ChatModel。** 模型只需要实现一个流式接口：`stream(messages, options?)` 返回 `AsyncIterable<AIMessageChunk>`。每个 chunk 携带一个可选的 `delta`（文本、推理 reasoning、工具调用开始 tool_use、或工具入参的 JSON 增量 input_json_delta），以及可选的 `done`/`stopReason`/`usage`。模型还可以选配只读的 `id` 和 `countTokens`。这个接口刻意只描述"如何产出 token 流"，至于怎么对接 Anthropic 之类的厂商，是适配器包的事。

**Tool。** 一个工具是 `name` + `description` + `inputSchema`（JSON Schema 形态的 `Record<string, unknown>`）加上一个 `execute(input, signal?)` 方法。`execute` 返回 `ToolExecuteResult`（`content` 字符串，可选 `isError`），允许同步或异步。

**run()。** 把上面三者粘起来的循环，本身是一个异步生成器。它逐步推进"调模型 → 流式拼装内容块 → 若有工具调用就执行并把结果喂回 → 再调模型"，直到模型不再请求工具、产出为空、或达到 `maxSteps`（默认 32）。过程中它会 yield 中间态的 `Message`：流式拼装时 yield 部分完成的 assistant 消息（每次内容有变化都 yield 一次），一轮工具执行完后 yield 一条带所有结果块的 user 消息。它还内置了几条务实处理：找不到工具或工具抛错时回填一条 `is_error` 的结果而不是中断；尊重传入的 `AbortSignal`。注意 `run()` 会就地修改你传入的 `messages` 数组（把 assistant 消息和工具结果 push 进去）。

`run()` 内部依赖 `stream-utils` 里的几个辅助函数完成 chunk 到 block 的折叠，这些函数也对外导出供上层复用：`mergeChunkIntoBlocks`、`finalizeToolUseInputs`、`collectStream`（把整条流一次性收集成 `{ blocks, stopReason, usage }`）。

## 怎么用

```ts
import { run } from "@my-agent-team/core";
import type { ChatModel, Message, Tool } from "@my-agent-team/core";

const echoTool: Tool = {
  name: "echo",
  description: "原样返回输入文本",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  execute(input) {
    const { text } = input as { text: string };
    return { content: text };
  },
};

declare const model: ChatModel; // 由某个适配器提供

const messages: Message[] = [{ role: "user", content: "你好" }];

// 签名是位置参数：run(model, tools, messages, options?)
for await (const message of run(model, [echoTool], messages, { maxSteps: 8 })) {
  console.log(message.role, message.content);
}
```

## 依赖关系

`core` 不依赖仓库里任何其他包，是整个系统的地基。反过来，它被广泛依赖：`framework`、`adapter-anthropic`、`harness`、`tools-common`、`runner-protocol`、`runner-daemon`、`test-helpers`、各类 `plugin-*`，以及 `apps/backend`、`apps/cli`。
