# @my-agent-team/cli

本地命令行入口,用一个 readline REPL 跟 agent 对话。它既能在进程内直接跑模型和工具,也能连远端 backend,适合开发调试和无界面场景。

## 它负责什么

cli 是单个 agent 的本地驱动入口。它从 `process.argv` 解析 `--key=value` 形式的参数(见 `src/args.ts`),据此决定以哪种方式启动,然后进入一个交互循环:读一行输入,把它跑成一次 agent/模型调用,边产出边流式打印到终端。

启动方式由参数组合决定:

- 不带 `--backend`、不带 `--workspace`:进程内直跑 `@my-agent-team/core` 的 `run()` 循环,自带 web-fetch、web-search、memory、read/write 工具。这条路径额外需要 `TAVILY_API_KEY`。
- 带 `--workspace=<dir>`:用 `@my-agent-team/harness` 的 `createGenericAgent()` 起一个挂载该工作区(`@my-agent-team/agent-fs`)的完整 agent,在本地跑完整的 harness/插件栈。
- 带 `--backend=<url>`:远端线程模式,`POST /api/threads/:id/runs` 触发,再订阅 `GET /api/runs/:id/events` 的 SSE 流;断线时用 `Last-Event-ID` 续传。
- 带 `--backend=<url> --conversation=<id>`:多人会话模式,先创建/加入会话,再 `POST /api/conversations/:id/messages` 发消息;支持 `@<member> <text>` 定向某个 agent,并从会话 SSE 流里读其他成员的回复。
- 带 `--rm=<agentId>`(需配合 `--backend`):管理操作,确认后 `DELETE /api/agents/:id` 归档该 agent;加 `--hard` 则物理删除且不可恢复。

## 流式输出

各模式共用同一套渲染逻辑:assistant 的文本块即时写到 stdout,`tool_use` 显示为 `[tool: <name>]`,工具结果显示为带 OK/FAIL 的截断预览。

## 怎么跑起来

package.json 提供 `start` 脚本,等价于 `bun run src/main.ts`:

```bash
# 进程内直跑(需 ANTHROPIC_API_KEY、TAVILY_API_KEY)
bun run src/main.ts

# 本地工作区 + 完整 harness
bun run src/main.ts --workspace=~/my-project

# 连远端 backend
bun run src/main.ts --backend=http://localhost:3000

# 多人会话
bun run src/main.ts --backend=http://localhost:3000 --conversation=conv-abc

# 删除 agent
bun run src/main.ts --backend=http://localhost:3000 --rm=agent-42 --hard
```

其他参数:`--model`(默认 `claude-opus-4-7`)、`--max-steps`(默认 `32`,仅进程内模式)、`--system`(系统提示)。环境变量:`ANTHROPIC_API_KEY`(必需),`TAVILY_API_KEY`(进程内模式的 web-search 需要)。

## 依赖

工作区内依赖 core、adapter-anthropic、harness、tools-common、agent-fs;远端模式只通过 HTTP/SSE 对接 backend。
