---
title: 飞书接入向导
description: 「某个 Agent 现在能不能和飞书对话」的唯一答案：backend 把 agent 配置、授权会话、lark-bot registry 与心跳合成一个读模型（LarkSurfaceView），Web 面板按它渲染，lark-cli 授权链接经读模型回流，oma 只做诊断不发命令
tags: [lark, surfaces, web, backend]
---

# 飞书接入向导

一句话：本页是「把一个 Agent 接到飞书」这条路的权威描述。状态由 backend **合成**——一个读模型（`LarkSurfaceView`）同时看四个数据源：agent 配置、授权会话、lark-bot registry、心跳。Web 用它渲染唯一一块面板，`oma gateway doctor` 用它出诊断。oma 没有 `oma lark *` 子命令，也不需要：飞书身份在 backend 一侧，CLI 拿不到。

## 范围

覆盖：`GET /api/agents/:id/lark` 的 DTO 与状态阶梯，`lark_setup_session` 表与授权会话状态机，lark-cli 授权链接的回流路径，Web 面板与它的轮询规则，`oma gateway doctor` 的 Lark 段。

不覆盖：lark-bot 进程自身（入站/出站/卡片见[飞书端](./lark.md)）、Run 卡片与终态投递（见 [ADR 0031](../../adr/0031-lark-run-card-transient-projection.md)、[飞书消息端到端](../flows/e2e-lark-message.md)）、Agent 的权限模式与审批（见 [Agent Backend](../execution/agent-backend.md)）。

## 实现文件

- `apps/backend/src/features/agent/lark-surface.ts` — 读模型：纯函数 `buildLarkSurfaceView`，状态阶梯、访问模式、问题与动作都从入参推导
- `apps/backend/src/features/agent/http.ts` — 四个路由：读模型、建会话、读会话、取消会话
- `apps/backend/src/features/lark-bot/setup-manager.ts` — 授权会话状态机（起 lark-cli、收链接、终态、过期与回收）
- `apps/backend/src/features/lark-bot/setup-store.ts` — 会话表读写（`lark_setup_session`，含 tombstone）
- `apps/backend/src/features/lark-bot/provisioner.ts` — 跑 `lark-cli config init --new` 并按行解析出授权链接
- `apps/backend/src/bootstrap/features.ts` — 唯一同时握有四个数据源的组装点（`larkSurfaceFactsOf`）
- `apps/web/src/features/lark/LarkSurfacePanel.tsx` — 面板本体（唯一入口，旧的第二个向导已删除）
- `apps/web/src/features/lark/queries.ts` — 读模型查询与「只在动的时候轮询」的规则
- `apps/oh-my-agent/src/core/gateway/doctor.ts` — `oma gateway doctor` 的 Lark 两段探测

## 一个答案，四个来源

| 来源 | 提供什么 | 谁提供 |
|---|---|---|
| agent 配置 | `enabled`、`appId`、`profileRef`、机器人名、白名单、群策略 | route 从 agent row 读 |
| 授权会话 | 会话 id / 状态 / 截止时间 / **授权链接** / 失败原因 | `LarkSetupManager.getByAgentId`（取最新一条） |
| registry | 这个 agent 的 bot 进程此刻的状态 | `larkBotRegistry.statusOf` |
| 心跳 | `lastSeenAt`、`lastError`、待投递计数以及绑定的聊天清单 | ops 的 `getAgentRuntime` |

四者在 `bootstrap/features.ts` 里合流（只有这个作用域同时拿得到），推导本身在 `lark-surface.ts` 的纯函数里，因此可以单测。

## 状态阶梯

`authorized = enabled && (profileRef 非空 || 心跳新鲜)`——**心跳算授权**：网关可以用显式 profile 起 bot 而不回写 `profile_ref`，那种情况下 bot 明明在答话，把工作区判成「未连接」就是撒谎。心跳新鲜 = `lastSeenAt` 距今 < 95 秒（bot 每 30 秒一跳，三次没跳算真断）。

| 状态 | 判定 |
|---|---|
| `not_connected` | 未授权，且没有正在进行的授权会话 |
| `authorizing` | 未授权，但有 `status=pending` 的会话（你正在开放平台点） |
| `error` | 已授权，registry 报 `error` |
| `degraded` | 已授权，heartbeat 带了 `lastError` |
| `online` | 已授权且心跳新鲜 |
| `starting` | 已授权但没有新心跳：可能刚起来，也可能死了，`issue` 负责区分 |

访问模式（`owner_only` / `allowlist` / `chat_members` / `everyone`）是白名单的**诚实名字**：空白名单是 `allowlist`（0 人，拒绝），只有显式 `"*"` 才是 `everyone`。群聊里的 @bot 要求由 `groupMention` 单独表达，`enabled` 跟随 `groupPolicy`，`ready` 还需要机器人名。

## 问题与动作

`setup.issue` 是「为什么现在不能用」的一句话加一个动作：`setup_expired`（会话过期，`restart_setup`）、`setup_failed`（会话失败，标题里带 CLI 的原因，`restart_setup`）、`cli_missing`（宿主机没有 lark-cli，`install_cli`）、`profile_invalid`（开着但没授权且没有心跳，`reconnect`）、`bot_name_missing`、`surface_offline`。

`actions` 只广告**有真实入口**的动作：`canStartSetup`（没有 pending 会话且宿主机能起 CLI）、`canDisable`/`canRestart` 在已授权时为 true（重启是组合能力：关掉再打开，走 registry 自己的 stop/start）、`canReplaceApp` **恒为 false**——换 app 还没有 HTTP 入口，所以界面上不给假按钮。

## 授权会话

`lark_setup_session` 一行一个会话，终态（`completed`/`failed`/`expired`/`cancelled`）**保留**为 tombstone，24 小时后清。待处理（`pending`）会话在**新进程里不可信**：lark-cli 子进程随上一个进程死了，所以 `LarkSetupManager` 第一次被构造时会把遗留的 pending 一律判过期；管理器是按需构造的（首次用到才建），因此「上一次启动遗留的 pending」会在第一次使用时被判过期。

lark-cli 打印授权链接要**几分钟**，POST 的响应里不可能带上它——所以链接是会话的一个字段，跟着**读模型**回流到面板，而不是只在发起那个标签页的内存里。取消是 `SIGTERM`（绝不 `SIGKILL`，要尊重 CLI 自己的清理）。

## Web 面板

一块面板承担全部状态（旧的第二个向导已删）：未连接 → 授权中 → 验证中 → 在线／降级，外加设置区（机器人名、谁可以用、群聊策略）与高级区（profile、app、最后一次心跳）。两条硬规则来自实际翻车：

1. **读模型是唯一事实源**：面板上出现的每个状态都必须有字段产出它，广告的每个动作都必须有 HTTP 入口。授权链接也因此走读模型——否则刷新页面（或换个标签打开）就会永远停在「正在向 lark-cli 要链接」，而服务端其实早就有可用链接。
2. **读模型没回来之前不画可点的按钮**：默认值渲染成「未连接 + Connect」会让人点到一次正在加载的动作。

轮询只在状态还会自己变的时候开：`authorizing` 与 `starting` 每 3 秒一次，其余状态一次请求就是静止的。

## oma 侧

`oma gateway doctor` 有两段 Lark 探测：`lark-cli` 在不在 PATH、`lark-surface` 的汇总（几个 surface、几个在跑）。没有 token 时它只报「读不到」而不是「没有配置」——401 不能读成「没东西可报」。这里没有 `oma lark login/status` 这类动词：飞书身份属于 backend，CLI 只看得到宿主机上的 lark-cli 本身。

## 不变量

1. 每个 Agent 只有一块面板、一个向导；不存在第二条并行状态机。
2. 读模型是唯一事实源：状态来自真实字段，动作来自真实入口，没有生产者的分支要么补生产者，要么删掉。
3. 授权链接属于服务端会话，不属于某个标签页：刷新、换标签、换设备都还能看到同一个链接。
4. 空白名单是拒绝（`allowlist`、0 人），`"*"` 才是 `everyone`。
5. 读模型未返回前不显示可操作按钮。
6. 会话终态保留为 tombstone；上一个进程遗留的 pending 在新进程里判过期，不假装还活着。
7. 取消一律 `SIGTERM`，让 lark-cli 自己清理服务端订阅。

## 已知缺口

- **成员选择器**需要 contacts 授权范围，app 目前没有，所以白名单只能填 open_id（面板上写明了这一点）。
- **替换 bot 的 app** 没有 HTTP 入口（`canReplaceApp` 恒 false）：要换 app 得重新走一次授权。
- **向导要求宿主机有 lark-cli**：没有就报 `cli_missing` 并给出安装动作，浏览器端无从替代。
- 向导这条路的端到端验证依赖真机（web + backend + lark-cli + 开放平台），自动化测试覆盖的是读模型与路由，覆盖不到「在开放平台点完授权」那一步。
