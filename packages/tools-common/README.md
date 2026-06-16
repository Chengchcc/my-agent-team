# @my-agent-team/tools-common

agent 能对外界做事的那套标准工具，都在这里：跑命令、读写改文件、搜代码、上网、存取记忆。同时也包含把这些工具关进工作区沙箱的原语。

## 为什么需要它

framework 只定义了 `Tool` 这个抽象——一个有名字、有输入 schema、有 `execute` 的对象。它不规定具体有哪些工具，因为工具是“能力”，属于装配层的选择。tools-common 就是这套共享能力库：把 agent 日常需要的动作实现成一组可复用、可独立测试的 `Tool`，让 harness（以及任何上层）按需挑选、拼装。

它还解决一个绕不开的安全问题：agent 跑 bash、读写文件时，必须被限制在自己的工作区里，不能越界访问宿主机的任意路径。这部分由本包的 **sandbox 原语** 负责，是所有“接触真实文件系统”的工具的共同地基。

职责边界：tools-common 只提供工具本身和沙箱包裹，不负责决定哪个 agent 用哪些工具（那是 harness 的事），也不实现模型或插件。

## 核心概念

**两类文件工具。** 文件操作分两套，针对不同场景：

- **逻辑路径工具**（走 AgentFS）：`createReadToolForWorkspace`、`createWriteToolForWorkspace`、`createEditToolForWorkspace` 三个工厂函数，各自接受一个 `AgentFsLike` 实例，返回名为 `read` / `write` / `edit` 的工具。它们用逻辑路径（如 `/SOUL.md`、`/memory/today.md`），由 AgentFS 负责把逻辑路径映射到实际存储。`edit` 的语义是把 `old_string` 精确替换为 `new_string`（一次一处）。
- **进程/真实路径工具**：`bashTool`（名字 `bash`，用 `setsid` 起新进程组，默认超时 30s、上限 600s）、`grepTool`（名字 `grep`，底层是 ripgrep，需系统装有 `rg`）、`globTool`（名字 `glob`，基于 `Bun.Glob`，结果上限 500 条）。这些是直接对外导出的 `Tool` 常量，需要配合沙箱使用。

**sandbox 原语。** 这是把真实路径工具关进笼子的机制：

- `AgentFsRoots` 是工作区描述符，含 `privateRoot` 和一组 `posixRoots`。
- `resolveInWorkspace(workspace, userPath)` 把用户给的路径解析到允许的根之下；一旦越界就抛 `SandboxError`。
- `withWorkspace(tool, workspace)` 把任意工具包一层：执行前校验输入里所有路径键（`path`/`filePath`/`file_path`/`cwd`），把它们 resolve 进工作区，并在工具接受 `cwd` 且调用方没给时填入默认工作目录。harness 正是用它来包裹 `bashTool`/`grepTool`/`globTool`。

**网络工具。** `webFetchTool`（名字 `web_fetch`）抓取一个 URL 返回纯文本，内置 URL 安全校验、手动跟随重定向、超时与响应大小上限。`createWebSearchTool(apiKey)` 是工厂函数，返回名为 `web_search` 的工具，底层走 Tavily，返回 top 结果的 JSON。

**文件记忆工具**在 `@my-agent-team/plugin-fs-memory` 里（`memory_read`/`memory_write`/`memory_search`），基于 AgentFS 持久化。tools-common 不再提供内存版记忆工具。

**AgentFsLike。** 逻辑路径工具依赖的最小文件系统接口（`read`/`write`/`list`/`stat`/`exists`/`mkdirp`），AgentFS 通过结构化类型天然实现它。配套还导出一个路径拼接小工具 `pjoin`。

## 怎么用

```ts
import {
  bashTool,
  withWorkspace,
  createWriteToolForWorkspace,
  type AgentFsRoots,
} from "@my-agent-team/tools-common";

const roots: AgentFsRoots = {
  privateRoot: "/work/agent-123",
  posixRoots: ["/work/agent-123"],
};

// bash 关进沙箱：路径会被 resolve 进工作区，越界抛 SandboxError
const safeBash = withWorkspace(bashTool, roots);

// 结构化写文件工具，ws 实现 AgentFsLike
const writeTool = createWriteToolForWorkspace(ws);

const result = await safeBash.execute({ command: "ls -la" });
console.log(result.content);
```

## 依赖关系

tools-common 只依赖 core（拿 `Tool` 类型）。反向看，它被 harness、plugin-fs-memory、plugin-progressive-skill 使用。
