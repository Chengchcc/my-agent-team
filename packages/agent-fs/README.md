# @my-agent-team/agent-fs

一套基于能力（capability）的虚拟文件系统。它把若干后端按路径前缀挂载到一棵统一的逻辑文件树上，agent 通过 `/shared/`、`/private/` 这样的逻辑路径读写文件，而真正落在哪里、能不能写，由挂载表决定。

## 为什么需要它 / 解决什么问题

agent 需要读写文件，但你不能把真实磁盘原样交给它。不同区域有不同的信任级别：共享区也许只读，私有区可写，外部区是临时内存。同时，agent 看到的路径应该是稳定、抽象的，不应暴露宿主机上随版本变化的真实目录。

直接给模型一个 `node:fs` 危险且僵硬。这个包在中间放一层挂载表：每条挂载声明一个路径前缀、绑定一个后端、标注一个信任域。所有访问都先经过路径归一化和挂载解析，再分派到对应后端。于是「能力」是显式声明出来的——没有挂载到的路径根本无法访问，没有 `write` 能力的后端天然只读。

职责边界：它只负责路径解析、挂载分派和访问控制，不提供工具，也不关心文件内容的语义。把它包装成 agent 工具是上层（tools-common / 各插件）的事。

## 核心概念

核心类是 `AgentFS`，构造时接收一个挂载数组：`new AgentFS({ mounts: MountEntry[], aliases? })`。注意 `mounts` 是一个 `MountEntry[]` 数组，不是单一的 root 配置。

每个 `MountEntry` 包含：

- `prefix` —— 逻辑路径前缀，必须以 `/` 结尾，例如 `/shared/`。
- `backend` —— 一个 `ReadableBackend`；若它同时实现 `write`/`mkdirp`/`remove`，就是 `WritableBackend`，对应路径才可写。
- `domain` —— 信任域，取值 `"shared" | "private" | "external" | "runner_state"`。
- `posixRoot?` —— 可选的真实 POSIX 根，用于把逻辑路径映射回宿主机路径（例如让 bash/grep 能定位到文件）。

解析逻辑：路径先归一化（去掉 `.`/`..`，拒绝越出根目录的逃逸），再经 `PathAliasResolver` 转成 canonical 形式，最后匹配最长前缀的挂载。能力是分层的——`read`/`list`/`stat`/`exists` 走任意后端；`write`/`mkdirp`/`remove` 会检查目标后端是否可写，否则抛出 `AgentFsAccessError`（read-only mount）。这些方法都只接受路径字符串，没有 `{ root }` 这类选项参数。

`AgentFS` 还提供 `mountsForDomain(domain)` 按域筛选挂载、`posixRoots()` 汇总所有真实根。内置后端有 `LocalBackend`（落到真实磁盘）和 `MemoryBackend`（纯内存）。一组工厂函数帮你快速搭好常见布局：`makeDefaultMounts` / `makeAgentFsHandle`（shared + private）、`makeSharedOnlyMounts` / `makeSharedOnlyAgentFS`、`makeDevAgentFsHandle`、`makeExternalMount`。Handle 类型 `AgentFsHandle` 把 `fs` 实例和 `privateRoot`、`posixRoots`、`displayRoot` 一起打包返回。

## 怎么用

```ts
import { AgentFS, LocalBackend, MemoryBackend, type MountEntry } from "@my-agent-team/agent-fs";

const mounts: MountEntry[] = [
  { prefix: "/shared/", domain: "shared", backend: new LocalBackend("/data/shared") },
  { prefix: "/private/", domain: "private", backend: new LocalBackend("/data/private"), posixRoot: "/data/private" },
  { prefix: "/tmp/", domain: "external", backend: new MemoryBackend() },
];

const fs = new AgentFS({ mounts });

await fs.write("/private/notes.md", "hello");   // 命中可写挂载
const text = await fs.read("/private/notes.md"); // string | null
await fs.read("/shared/readme.md");              // 命中只读挂载

const privateMounts = fs.mountsForDomain("private");
const roots = fs.posixRoots();
```

需要标准布局时用工厂更省事：

```ts
import { makeAgentFsHandle } from "@my-agent-team/agent-fs";

const handle = makeAgentFsHandle({ sharedRoot: "/data/shared", privateRoot: "/data/private" });
await handle.fs.write("/private/a.txt", "x");
```

依赖关系：本包零运行时依赖（`LocalBackend` 使用 Node 内置 `node:fs`/`node:path`）。包内被 `harness`、`runner-daemon`、`apps/backend` 使用。
