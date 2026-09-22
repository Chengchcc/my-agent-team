---
title: Oma 插件与 HITL
description: 插件 manifest 优先级与 code 加载形状、scope × mode 信任矩阵，以及 permissionMode 门控下的审批往返与 auto 分类器
tags: [plugins, oma, security, mcp]
---

# Oma 插件与 HITL

一句话：本页是 oma 插件系统与人工审批链的权威描述。插件 = 多源 manifest 解析 + 用 Bun 原生 `import()` 加载的 code 组件（tools / hooks）+ 目录 sha256 信任矩阵（scope × mode）+ marketplace 多源 catalog；HITL 审批链 = `permissionMode` 门控 + `approval_request` / `resolve_approval` 往返 + 超时 fail-closed。

## 范围

覆盖：manifest 优先级与冲突矩阵、code 组件的加载形状与失败语义、信任矩阵、插件提供的 MCP 与技能、workspace `.mcp.json` 的门控、HITL 审批链与分类器、`--tools` 过滤。

不覆盖：技能的索引与加载（见 [渐进式技能](./progressive-skill.md)）、skill pack 的分发（见 [技能包管理](./skill-pack.md)）、工作区目录布局与 bridge（见 [Agent 工作区与多后端](../agents/workspace-and-backends.md)）、工具表全貌（见 [Oma Tools](../runtime/oma-tools.md)）。

## 实现文件

- `apps/oh-my-agent/src/core/plugins/plugin-marketplace.ts` — manifest 多源、marketplace catalog、安装与启用
- `apps/oh-my-agent/src/core/plugins/plugin-trust.ts` — 目录 / 文件 sha256 与信任记录
- `apps/oh-my-agent/src/core/plugins/plugin-resolve.ts` — scope × mode 策略矩阵与 code 加载编排
- `apps/oh-my-agent/src/core/plugins/plugin-code.ts` — 单个 code 条目的加载与形状校验
- `apps/oh-my-agent/src/core/tools/mcp-mount.ts` — MCP 挂载、命名、变量替换、超时
- `apps/oh-my-agent/src/core/runtime/run-runtime.ts` — 权限门、workspace MCP 门控、插件工具的冲突处理
- `apps/oh-my-agent/src/core/runtime/{approval,permission-classifier,tool-filter}.ts` — 审批、分类器、`--tools`
- `apps/oh-my-agent/src/modes/tui/*` — `/plugin`、`/mcp trust`、审批面板
- 产品侧链路：`apps/backend/src/features/agent-run/{http,execution-service}.ts`、`modes/rpc/rpc-mode.ts`

## 插件 manifest

一个插件目录可以同时有多种 manifest，按优先级取：

```text
plugin.json（oma）  >  .claude-plugin/plugin.json  >  package.json（含 name）
```

- 只有 oma 的 `plugin.json` 里的 `tools` / `hooks` 会被当成代码入口。
- `.claude-plugin/plugin.json` 只补 `version` / `description` / `skills` 这些元数据。
- `package.json` 的 `omp` / `pi` 字段以及 claude 的 `hooks` / `commands` / `agents` 都不执行，只产出一条警告。
- 冲突与忽略都以**警告**的形式冒泡到 resolve 结果里，安装记录里也能查到（`manifestWarnings`），不会静默丢掉。

插件装到两个位置之一：user scope 是 `<agentDir>/plugins/<name>`，project scope 是 `<workspace>/.oma/plugins/<name>`；同名时 project 覆盖 user。安装就是把源目录 `cpSync` 过去，源名与源路径都在 marketplace 根内校验（marketplace.json 是远端内容，不校验的话安装与卸载会变成任意复制、任意删除）。

marketplace catalog 也是双源：`marketplace.json` 优先，`.claude-plugin/marketplace.json` 兜底。git / zip 源物化时把取到的 rev 记成版本号，本地目录源没有版本号。

## 代码组件怎么加载

- 入口由 manifest 声明，加载方式是 **Bun 原生动态 `import()`**，没有 jiti，也不需要预编译。
- 加载前先做 realpath 检查：入口文件必须在插件根之内，符号链接或 `../` 逃逸一律拒绝（信任哈希覆盖的是插件根的树，逃出根就绕过了审批）。
- 形状校验：`tools` 导出必须是 `PluginTool[]`（有 name / description / execute）；`hooks` 导出只认 9 个已知键（`beforeRun`、`afterRun`、`beforeModel`、`afterModel`、`beforeTool`、`afterTool`、`transformToolArgs`、`beforeStop`、`afterStop`），未知键忽略并警告。
- **任何失败都不抛**：入口加载失败、形状不对，都只是这个插件被跳过并记一条警告，绝不拖垮 Run。
- 工具名冲突时原生胜，被遮蔽的插件工具是**丢弃**而不是合并，并且会说明原因。

hooks 走同步签名：`beforeTool` 返回 block 时，权限门都不再执行（插件 block 优先于审批）。

## 信任矩阵

| scope | 条件 |
|---|---|
| user | 安装即同意（`enabled` 为真就加载） |
| project | 需要信任记录命中当前内容哈希，否则跳过并给出 `/plugin trust <name>` 提示；**rpc 模式直接跳过**，连提示都只是警告 |

哈希是插件根的递归 sha256：按相对路径排序后逐条聚合，**每个非目录条目都参与**——普通文件按内容、符号链接按链接目标、其他类型按标记。任何条目被排除都是绕过审批的旁路（把 `node_modules` 或符号链接排除在外曾经是真实缺口）。记录存在 `<agentDir>/trusted-plugins.json`；文件损坏等于空表，也就是全不信任；内容一变哈希就变，审批自动失效。

同一个信任文件还存单文件的哈希，供 workspace `.mcp.json` 的门控使用。

## 插件提供的 MCP 与技能

- 插件目录里的 `.mcp.json` 与 code 组件受同样的 scope × mode 策略约束。
- 挂载时 `${CLAUDE_PLUGIN_ROOT}` 与 `${CLAUDE_PROJECT_DIR}` 会被替换成真实路径，并作为同名 env 导出给 server 进程。
- 插件的 `skills` 目录（缺省是 `<插件根>/skills`）在插件启用时加入技能发现根，因此插件的技能会出现在 Meta 的技能索引里，也能被 `/skill:<name>` 调到。

## Workspace MCP 的门控

工作区根 `.mcp.json` 是仓库内容，可能被 Agent 或用户写。独立模式（print / json / tui）默认不信任：文件哈希不在信任记录里时，**一个 server 都不挂**（fail-closed，不是逐个筛），并提示跑 `/mcp trust`。产品走的 rpc 模式跳过这道门——那个文件是 bridge 自己写的，见 [Agent 工作区与多后端](../agents/workspace-and-backends.md)。

## HITL 审批链

```text
工具调用触发 permissionMode 门
→ child 发 approval_request 事件 { callId, toolName, reason, input, sandboxed? }
→ adapter 透传（名字是 backend.oma.*）→ 产品 SSE → Web 的 Allow/Deny 卡片
→ POST /api/agent-runs/:runId/approval { callId, decision }
→ adapter 发 resolve_approval 命令 → child 继续或中止
```

- `permissionMode` 三态与 `yolo` 的差别见 [Oma Tools](../runtime/oma-tools.md) 的权限门一节。
- `ApprovalRequest.source` 标明是谁在问：`permission`（ask 门）、`tool`（插件工具自己请求）、`classifier`（auto 模式判 block 后升级给人）。`sandboxed` 用来在卡片上区分"沙箱内执行"与"不受沙箱约束的回退"。
- `callId` 必须是**工具调用自己的 id**：它是人卡唯一能对上的键，另造一个会让审批往返静默失效。
- 超时默认 120 秒（`OMA_APPROVAL_TIMEOUT_MS`），超时等于 deny；没有 handler 的 ask 也是 deny（fail-closed）。print / json 两个无人模式用 `denyAllApprovals`。
- 审批表按 Run 隔离，Run 结束后没有人再能解决它的审批。

分类器（`auto` 模式）：

- 输入是系统规则 + 最近若干条**用户**消息 + 待执行动作（截断），**永不包含 tool results**，防止工具输出里的文字反过来操纵分类器。用户说过的禁令（"别 push"）对它有约束力。
- 判定解析 fail-closed：解析不出来等于 block。
- `block` 会升级给人一次（同一动作只发一张卡），重复同一动作静默 deny；升级用的是同一条审批链。
- 模型可由 `OMA_PERMISSION_CLASSIFIER_MODEL`（或 `.oma/settings.json`）固定，缺省用本次 Run 自己的模型；超时默认 30 秒（`OMA_CLASSIFIER_TIMEOUT_MS`）。
- 硬熔断在分类器**之前**：`rm -rf` 指向根、顶层目录、home 或裸变量 glob 时直接拦下，人工审批也覆盖不了。
- 主会话与每个子代理会话共用同一套策略（含升级去重集），只是判定时参照的意图不同：子代理用自己收到的任务文本，加上主对话里的用户消息。策略由 `run-runtime.ts` 的 `makeSessionPermissionGate` 生产，子代理执行器（`core/delegation/executor.ts`）再以 `makePermissionGate` 接过去。

## --tools 过滤

`--tools` 在**最终**工具表（原生 + MCP + 插件汇总之后）统一过滤一次：纯名字是白名单（只留这些），`!name` 是黑名单。它同时约束子代理的工具表，模型看不到被滤掉的工具。插件工具没有命名约定，所以过滤器按最终表里的名字逐个判。

## 不变量

1. 插件代码走 Bun 原生 import，加载失败永不抛，只跳过并警告。
2. project-scope 的 code 组件与 MCP 永不进 rpc 模式。
3. 信任记录损坏等于全不信任；内容变更立即失效。
4. 审批超时等于 deny；没有审批管道时的 ask 也等于 deny。
5. 硬熔断不可被分类器或人审覆盖。
6. MCP 工具与插件的挂载都不会让一个坏项影响其他项或整个 Run。

## 已知缺口

- 插件 skills 目录里的技能只做索引与加载，没有 per-plugin 的开关粒度：插件启用即全启用。
- `hooks` 的同步签名意味着插件里的 hook 不能 await（要等还得走别的机制）。
- claude 生态只做周边兼容（marketplace catalog、`skills/`、`.mcp.json`），claude 的 hooks.json 协议、commands、agents、LSP 都不支持，只有警告。

## 相关页

- [Oma Runtime](../runtime/oma.md) — 插件在装配里怎么进会话
- [Oma Tools](../runtime/oma-tools.md) — 工具表与权限门全貌
- [渐进式技能](./progressive-skill.md) — 插件技能的消费方
- [Agent 工作区与多后端](../agents/workspace-and-backends.md) — 工作区 `.mcp.json` 从哪来
- [安全模型](../security/overview.md) — 信任与边界的整体视图
