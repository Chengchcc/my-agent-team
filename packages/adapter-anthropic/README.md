# @my-agent-team/adapter-anthropic

把 Anthropic 的官方 SDK 适配成 core 定义的 `ChatModel`，让 agent 内核能用 Claude 模型流式对话。

## 为什么需要它

core 用 `ChatModel` 接口描述“一个能流式产出 token 和工具调用的模型”，framework 和 agent 只认这个接口，不关心背后是哪家供应商。这样设计的好处是模型可替换——但代价是每个真实供应商都需要一层适配，把它的 SDK 协议翻译成 `ChatModel` 的统一形状。

adapter-anthropic 就是 Anthropic/Claude 这一侧的翻译层。它处理两个方向：把 core 的 `Message[]` 转成 Anthropic 的请求参数，再把 Anthropic 的流式事件转回 core 的 `AIMessageChunk`。其他东西（工具实现、断点、agent 循环）都不归它管，它只负责“和 Claude 说话”。

## 核心概念

**AnthropicChatModel。** 实现了 `ChatModel` 的类，核心是异步生成器 `stream(messages, options?)`，逐块吐出 `AIMessageChunk`。它在转换时做了几件实事：把所有 system 消息合并成一段、过滤空消息、合并相邻同角色消息，再转成 Anthropic 的 message 参数。流里 `text` 和 `tool_use`（含 `input_json_delta`）会被透出，而 `thinking` / `redacted_thinking` 类内容被刻意过滤掉、不暴露给上层。流结束时给出 `done`，带上 `stopReason` 和 token 用量（input/output 以及缓存创建/读取）。

**配置项（AnthropicChatModelConfig）。** 构造函数接受一个可选 config，全部字段都是可选的：

- `model`：模型名，缺省回退到 `"claude-opus-4-7"`；实例的 `id` 也取这个值。
- `maxTokens`：最大输出 token，缺省 16000。
- `thinking`：形如 `{ type: "adaptive" }`，给上就透传。
- `effort`：`"low" | "medium" | "high" | "xhigh"`，给上就透传。
- `apiKey`：缺省依次回退到环境变量 `ANTHROPIC_API_KEY`，再 `ANTHROPIC_AUTH_TOKEN`。
- `baseUrl`：自定义网关地址，透传给 SDK 的 `baseURL`。

**toAnthropicTools。** 一个纯函数，把 core 的 `Tool[]` 映射成 Anthropic 的工具声明（取 `name` / `description` / `inputSchema`）。`stream` 在收到 `options.tools` 时内部就是用它来转换的，同时也单独导出，方便外部需要时复用。

## 怎么用

```ts
import { AnthropicChatModel } from "@my-agent-team/adapter-anthropic";
import type { Message } from "@my-agent-team/core";

const model = new AnthropicChatModel({
  model: "claude-opus-4-7",
  maxTokens: 16000,
  // apiKey 不传则读 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
});

const messages: Message[] = [{ role: "user", content: "你好" }];

for await (const chunk of model.stream(messages)) {
  if (chunk.delta?.type === "text") process.stdout.write(chunk.delta.text);
  if (chunk.done) console.log("\nstop:", chunk.stopReason);
}
```

## 依赖关系

adapter-anthropic 依赖 core（拿 `ChatModel` 等类型）和 `@anthropic-ai/sdk`。反向看，它被 runner-daemon 和 backend app 使用——它们在创建 agent 时把它作为模型实例传进去。
