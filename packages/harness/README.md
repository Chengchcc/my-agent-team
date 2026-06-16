# @my-agent-team/harness

把一个工作区目录变成一个能干活的 agent。harness 负责读取工作区里的文件、拼出系统提示、装配默认工具与插件，然后交给 framework 跑起来。

## 为什么需要它

framework 提供的是一个通用的 agent 运行内核：它知道怎么和模型对话、怎么调用工具、怎么保存断点，但它本身不关心“这个 agent 是谁、能用哪些工具、记忆放哪里”。这些都是策略问题，需要有人来做选择。

harness 就是这一层策略。它的核心立场是 **agent 的行为由工作区里的文件决定**，而不是写死在代码里。同一份 harness 代码，指向不同的工作区，就是不同的 agent——它们的身份（`SOUL.md`）、对用户的认知（`USER.md`）、记忆（`/memory/`）、技能（`/skills/`）都来自磁盘。harness 把这些文件读出来、组装好，再喂给 framework。

它的职责边界很清楚：harness 不实现工具、不实现插件、不实现模型适配器，那些分别住在 tools-common、各 plugin 包、adapter-anthropic 里。harness 做的只是“选哪些、怎么接线”。

## 核心概念

**bootstrap —— 从工作区文件拼系统提示。** `bootstrap(fs, logger, displayRoot?)` 是个 async 函数，返回一个 string，就是这次运行的 system prompt。它的逻辑是分阶段的：

- 如果工作区里存在非空的 `/BOOTSTRAP.md`，说明 agent 还没“出生”，直接返回这份诞生引导（让 agent 在第一次对话里和用户一起写出自己的 `SOUL.md`/`USER.md`）。但若 `SOUL.md` 已经存在，则认为 `BOOTSTRAP.md` 过期，删掉它继续。
- 如果工作区完全是空的（SOUL/USER/TOOLS/AGENTS、今天和昨天的日志都没有），返回内置的 `BOOTSTRAP_TEMPLATE`。
- 否则，读取 SOUL/USER/TOOLS/AGENTS 以及今天和昨天的记忆日志，交给内部的 `composeSystemPrompt` 拼成完整提示。

`BOOTSTRAP_TEMPLATE` 这个常量也对外导出，就是首次诞生时用的引导文本。

**createGenericAgent —— 一次性把 agent 接好线。** `createGenericAgent(opts)` 是 async 的，返回 framework 的 `Agent`。它内部依次做了：调用 `bootstrap` 得到系统提示；装配默认工具；装配默认插件；合并调用方传入的额外工具/插件（名字冲突会 fail-fast 抛错）；解析 checkpointer；最后调 framework 的 `createAgent`。

默认工具是六个：结构化 IO 的 `read`/`write`/`edit`（走 AgentFS 逻辑路径），以及经过工作区沙箱包裹的 `bash`/`grep`/`glob`（走 POSIX 真实路径）。默认插件三个：`fsMemoryPlugin`（文件记忆，挂在 `/memory/`）、`progressiveSkillPlugin`（渐进式技能，挂在 `/skills/`）、`taskGuardPlugin`。

`GenericAgentOptions` 里值得注意的字段：`workspace`（必填，AgentFsHandle）、`model`（必填，调用方自己选好的 ChatModel 实例）、`threadId`、`messages`、`extraPlugins`/`extraTools`，以及 `checkpointer`，它可以是一个实例，或字符串别名 `"memory"` / `"sqlite"`；默认是 sqlite，落在工作区的 `.checkpoints/db.sqlite`。

**permissionMode。** `permissionMode` 的取值是 `"ask" | "auto" | "deny"`，默认 `"ask"`。注意当前实现中这个字段只是接收下来、尚未真正参与执行控制（代码里以 `_permissionMode` 接住，留待后续接入）。

**reflectionGuidance / verificationGuidance。** 两个返回提示文本的函数。前者在一次正常任务跑完后注入，引导 agent 自己决定要不要把学到的东西写进记忆或微调 SOUL/USER；后者是“冷评审”引导，注入到一个 fork 出来的 agent 里，让它重新打开产物、逐条核对计划是否真的完成。

## 怎么用

```ts
import { createGenericAgent } from "@my-agent-team/harness";
import { AnthropicChatModel } from "@my-agent-team/adapter-anthropic";
// workspace: AgentFsHandle，由上层（如 runner / cli）准备好

const agent = await createGenericAgent({
  workspace,
  model: new AnthropicChatModel({ model: "claude-opus-4-7" }),
  threadId: "session-001",
  permissionMode: "ask",
  // checkpointer 默认 sqlite，落在工作区 .checkpoints/ 下
});

// 拿到的是 framework 的 Agent，按其接口驱动对话
```

## 依赖关系

harness 依赖 core、framework、tools-common、agent-fs 以及三个默认插件（plugin-fs-memory、plugin-progressive-skill、plugin-task-guard）。反向看，它被 runner-daemon 以及 backend、cli 两个 app 使用——它们负责准备工作区和模型，再调 `createGenericAgent` 把 agent 跑起来。
