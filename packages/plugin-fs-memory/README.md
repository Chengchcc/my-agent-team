# @my-agent-team/plugin-fs-memory

一个 framework 插件，给 agent 一份由文件系统支撑的长期记忆。每一轮模型调用前，它会把记忆内容自动注入系统提示；同时提供读取、搜索、写入记忆事实的工具。

## 为什么需要它 / 解决什么问题

agent 的上下文是临时的——一次对话结束，它就忘了之前学到的偏好和事实。要让记忆跨会话持续，就得把它落在上下文之外的地方，并在每次运行时重新带回来。

这个插件把记忆放进工作区的文件里，做两件事：一是开机注入，每轮自动把记忆读进系统提示，让模型「天生」就知道这些事，不必专门去查；二是显式工具，让模型在对话中按需查找已有事实、或写下新的事实供以后使用。注入是被动、无成本的回忆，工具是主动的检索与沉淀，两者配合。

职责边界：它只负责记忆的注入与读写编排，不决定该记什么——记什么由模型自己用 `memory_write` 决定。底层文件读写交给传入的 `AgentFsLike`。

## 核心概念

插件接收一个 `AgentFsLike` 工作区和记忆根目录（`root`，默认 `/memory/`），通过 framework 的 `beforeModel` 钩子工作。首次触发时它会确保 `root` 和 `root/facts` 目录存在，随后每一轮读取记忆内容（带 mtime 缓存，未变更不重复读盘），以 `<memory>` 块追加到系统提示之后；读取失败或没有系统消息时记日志并跳过注入（fail-open）。

记忆以「事实（fact）」为单位存成带 frontmatter 的 Markdown 文件，每条事实有标题、标签和正文。插件贡献的工具有：

- `memory_read` —— 读取记忆内容。
- `memory_search` —— 按关键词搜索事实。打分规则是标签命中 +3、标题命中 +2、正文命中 +1，按分排序后取前 `limit` 条（默认 `searchLimit`，即 5），返回每条的 `path`/`title`/`tags`/`snippet`。
- `memory_write` —— 写入一条新事实，入参 `{ content, tags? }`，落盘后让缓存失效。仅当 `enableWrite` 为真（默认开启）时注册这个工具。

也就是说，关掉写入就得到一份只读记忆。

## 怎么用

```ts
import { fsMemoryPlugin } from "@my-agent-team/plugin-fs-memory";
import type { AgentFsLike } from "@my-agent-team/tools-common";

declare const ws: AgentFsLike;

const plugin = fsMemoryPlugin({
  ws,
  root: "/memory/",   // 记忆根目录，默认 /memory/
  enableWrite: true,  // 是否注册 memory_write，默认 true
  searchLimit: 5,     // memory_search 默认返回条数
});

// 把 plugin 注册进 framework 的 agent 配置即可
```

依赖关系：依赖 `@my-agent-team/core`、`@my-agent-team/framework`、`@my-agent-team/tools-common`（`AgentFsLike` 与 `pjoin`）。包内被 `harness` 使用。
