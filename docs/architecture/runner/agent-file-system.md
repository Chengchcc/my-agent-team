---
id: runner.agent-file-system
title: Agent 文件系统
status: current
owners: architecture
last_verified_against_code: 2026-06-16
summary: "Agent 文件系统（AgentFS）是 Agent 在运行时看到的那套虚拟文件视图。它用一张挂载表把对外暴露的路径前缀映射到不同的后端与「域」。真实的两个根是 /shared 和 /private——常被误以为有 /workspace，其实没有；面向 Agent 的 /memory 映射到 shared 域，/skills 映射到 private 域。"
depends_on:
  - runner.resident-runner
used_by:
  - plugins.fs-memory
  - plugins.progressive-skill
---

# Agent 文件系统

Agent 文件系统（AgentFS）是 Agent 在运行时看到的那套虚拟文件视图。它用一张挂载表把对外暴露的路径前缀映射到不同的后端与「域」。真实的两个根是 /shared 和 /private——常被误以为有 /workspace，其实没有；面向 Agent 的 /memory 映射到 shared 域，/skills 映射到 private 域。

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

Agent 发起的每一次文件访问，都先按 `prefix` 匹配到一条挂载项，再交给对应 `backend` 执行。这样「Agent 视角的路径」和「真实存储位置」被彻底解耦：换后端、换物理根，对 Agent 透明。

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

## 关联页面

- [常驻 Runner](resident-runner.md)
- [文件型记忆插件](../plugins/fs-memory.md)
- [渐进式技能插件](../plugins/progressive-skill.md)
