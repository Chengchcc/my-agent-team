# @my-agent-team/agent-spec

定义后端与 runner 之间传递"启动一次运行"载荷的线缆契约（wire schema）。它只是一组 Zod schema 加上从中推断出来的 TypeScript 类型，本身不含任何运行逻辑。

## 为什么需要它

后端和 runner daemon 是两个独立进程，跨进程边界交换启动载荷时，必须对载荷的精确形状达成一致。如果两边各自硬编码字段，任何结构性的不匹配都会悄悄渗进运行时，等出错时已经很难定位。这个包把契约固化成 Zod schema：两边都用同一份 schema 去 `parse`，结构不对就在边界处直接抛错，而不是后面才暴雷。所以它刻意只做一件事——描述并校验载荷形状，唯一依赖是 `zod`。

## 核心概念

这里同时存在两代 schema。

**AgentSpecV1** 是较早的扁平对象，用 `z.object(...).superRefine(...)` 定义。除了模型、workspace、threadId、input 等基础字段，它还带有一批跨字段约束：`mode` 为 `"resume"` 时必须提供 `resumeCommand`；出现 `senderMemberId` 时必须同时提供 `conversationId`。它的 `mode` 取值是 `run | resume | reflect`，默认 `"run"`。从中推断出的类型导出为 `AgentSpec`。

**AgentSpecV2** 是 runner-daemon 当前使用的载荷，基于 `mode` 做了判别联合（`z.discriminatedUnion("mode", ...)`），三个分支各自携带不同字段：`run` 带 `input`，`resume` 带 `resumeCommand`，`reflect` 带 `input` 和 `parentRunId`。三个分支共享一组公共字段（`schemaVersion: "2"`、`agentId`、`runId`、`threadId`、`model` 等）。对应的窄化类型分别导出为 `AgentSpecV2Run`、`AgentSpecV2Resume`、`AgentSpecV2Reflect`。判别联合的好处是：`parse` 之后用 `spec.mode` 一判断，TypeScript 就能自动把类型收窄到对应分支。

**版本常量。** V1 的版本字符串是常量 `AGENT_SPEC_V1_VERSION`（值为 `"1"`）。还有一个旧名字 `CURRENT_SCHEMA_VERSION` 作为它的别名，已标注 `@deprecated`，新代码请用前者。V2 的版本号在 schema 里直接写死为字面量 `"2"`。

## 怎么用

后端构造并发送载荷：

```ts
import { AgentSpecV2 } from "@my-agent-team/agent-spec";

const payload = AgentSpecV2.parse({
  schemaVersion: "2",
  mode: "run",
  agentId: "agent-42",
  runId: "run-abc",
  threadId: "thread-xyz",
  model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  input: "部署应用",
});
```

runner 在边界处校验并按 mode 收窄：

```ts
import { AgentSpecV2, type AgentSpecV2Run } from "@my-agent-team/agent-spec";

const spec = AgentSpecV2.parse(rawPayload); // 边界处校验，结构不对立即抛错
if (spec.mode === "run") {
  const runSpec: AgentSpecV2Run = spec; // 由判别字段自动收窄
  // 用 runSpec.input 创建并运行 agent...
}
```

## 依赖关系

`agent-spec` 只依赖 `zod`。被 `apps/backend` 和 `runner-daemon` 这两个跨进程边界的两端依赖。
