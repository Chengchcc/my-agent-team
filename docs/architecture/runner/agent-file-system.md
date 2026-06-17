---
id: runner.agent-file-system
title: Agent 文件系统
status: current
owners: architecture
last_verified_against_code: 2026-06-17
summary: "Agent 文件系统（AgentFS）是 Agent 在运行时看到的那套虚拟文件视图。它用一张挂载表把对外暴露的路径前缀映射到不同的后端与「域」。文件系统契约（AgentFsLike）定义在 packages/core（L1 原语层），AgentFS 显式 implements 它。真实的两个根是 /shared 和 /private——常被误以为有 /workspace，其实没有。"
depends_on:
  - runner.resident-runner
used_by:
  - plugins.fs-memory
  - plugins.progressive-skill
---

# Agent 文件系统

Agent 文件系统（AgentFS）是 Agent 在运行时看到的那套虚拟文件视图。它用一张挂载表把对外暴露的路径前缀映射到不同的后端与「域」。

## 文件系统契约：AgentFsLike

`AgentFsLike` 是"Agent 能读写的文件系统长什么样"的规范定义，在 `packages/core`（L1 原语层，与 `Tool`/`Message`/`ChatModel` 并列）：

```ts
// packages/core/src/agent-fs.ts
export interface AgentFsLike {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  list(path: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number; size: number } | null>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
}
```

`AgentFS` 类（`packages/agent-fs`）显式 `implements AgentFsLike`，从 duck-typing 升级为编译期保证——任一方改签名会立即编译失败。依赖方向：`agent-fs → core`（L1 实现依赖 L1 契约，正确），`tools-common → core`（L2 工具层依赖 L1 契约，正确）。`agent-fs` 和 `tools-common` 是 `core` 的平行消费者，无环。

`ReadableBackend`/`WritableBackend`（`agent-fs/src/types.ts`）是 backend 层契约（相对路径、单挂载点），语义与 `AgentFsLike`（逻辑路径、多挂载聚合）不同层——两者保留，`agent-fs/src/types.ts` 中有注释说明分层关系。

## 挂载表是核心抽象

每一条挂载项是一个 `MountEntry`：

```ts
type MountEntry = {
  prefix: string        // Agent 看到的路径前缀，如 "/memory"
  backend: ...          // 实际承载读写的后端实现
  domain: Domain        // 该前缀归属的隔离域
  posixRoot?: string    // 若后端落到本地 POSIX，对应的真实根
}
```

Agent 发起的每一次文件访问，都先按 `prefix` 匹配到一条挂载项，再交给对应 `backend` 执行。

## 四个域

`domain` 把挂载划分到四类隔离边界：

| 域 | 含义 |
|------|------|
| `shared` | 跨运行/跨成员共享的数据，例如长期记忆 |
| `private` | Agent 私有，例如它的技能 |
| `external` | 外部挂载的资源 |
| `runner_state` | Runner 自身的执行状态 |

域不是装饰，它决定了「这块数据能被谁看到、生命周期跟谁走」。

## 真实的根：/shared 和 /private

这里有一个反直觉但重要的事实：**文件系统真正的根只有 `/shared` 和 `/private`，没有 `/workspace`。** 面向 Agent 暴露的友好路径是再映射出来的：

- `/memory` → **shared** 域（长期记忆，跨运行可见）
- `/skills` → **private** 域（Agent 私有技能）

之所以强调这点，是因为很多人会按直觉假设有个 `/workspace` 工作目录，然后把临时文件往那写——那条路径并不存在于挂载表里，写入会落空或报错。要写临时/共享数据，应当落在已挂载的前缀下。

## 别名解析：toCanonical

`DefaultWorkspaceAliases.toCanonical()` 负责把 Agent 看到的「逻辑路径」翻译成挂载表能识别的「规范路径」（`aliases.ts`）：

- `/shared/**` → 原样通过（已是规范路径）
- `/private/**` → 原样通过（已是规范路径）
- `/mnt/**` → 原样通过——`toCanonical()` 对 `/mnt/` 前缀走直接透传（`aliases.ts` 第 21 行），为外部挂载提供统一的规范命名空间
- `/memory/**` → `/shared/memory/**`（长期记忆走 shared 域）
- `/SOUL.md`、`/USER.md`、`/BOOTSTRAP.md`、`/TOOLS.md`、`/AGENTS.md` → `/shared/SOUL.md` 等——这些根级共享文件通过 `SHARED_ROOT_FILES` 集合映射到 shared 域（`aliases.ts` 第 4-10 行）
- 其余路径 → `/private/**`（默认归 private 域）

## MemoryBackend 与外部挂载

`MemoryBackend`（`backends.ts` 第 141-198 行）是一个纯内存的键值存储，实现了完整的 `WritableBackend` 接口（`read` / `write` / `list` / `stat` / `exists` / `mkdirp` / `remove`）。主要用于测试场景和临时数据。

`makeExternalMount(prefix)`（`mounts.ts` 第 62-64 行）创建一个 `domain: "external"`、`backend: new MemoryBackend()` 的挂载项。挂载后的路径通过 `/mnt/` 前缀的别名透传被 Agent 访问。

## AgentFsHandle

`AgentFsHandle`（`agent-fs.ts` 第 62-67 行）是 AgentFS 的完整句柄，聚合了：

| 字段 | 说明 |
|------|------|
| `fs: AgentFS` | AgentFS 实例 |
| `privateRoot: string` | 私有域的真实 POSIX 根路径 |
| `posixRoots: string[]` | 所有挂载的 POSIX 根路径列表 |
| `displayRoot: string` | 用于系统提示生成的工作区命名提示（`bootstrap.ts` 将其传入 `composeSystemPrompt`） |

## 关联页面

- [常驻 Runner](resident-runner.md)
- [文件型记忆插件](../plugins/fs-memory.md)
- [渐进式技能插件](../plugins/progressive-skill.md)
