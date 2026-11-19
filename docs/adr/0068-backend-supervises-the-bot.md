# ADR 0068: 机器人由 systemd 托管，后端是唯一的控制面

- 状态: Accepted
- 日期: 2026-11-19
- 相关: ADR 0044（channel SDK）、ADR 0067（Lark 面纪律）

## 背景

此前 Lark 机器人是 **backend 的子进程**（`DevLarkBotRegistry` spawn）。

三个后果，都在真机上出现过：

1. **重启 backend 就断开所有机器人。** 每重启一次，机器人重连一次；重连窗口里到达的事件没人接。
2. **机器人崩了只靠 backend 的退避重启**；backend 自己挂了，机器人跟着消失，且没有任何"外面有人看着我"的机制。
3. **"监听状态"只能看进程在不在**。进程活着、Lark socket 断了，面板仍显示 running。

运营者的要求原话：*"这个 systemd 应该是要 backend 可以控制的功能。开启/关闭/检查 lark bot 的监听状态。"*

## 决策

### D1 每个 agent 一个模板单元

`my-agent-team-lark-bot@<agentId>.service`（模板），由 `scripts/lark-bot-unit.sh` 启动。后端在启动机器人前写 `<dataDir>/lark-bot/<agentId>.env`（**0600**：里面有 backend token），单元用 `EnvironmentFile=` 读它。

启动脚本**只传非空的可选参数**：对机器人来说"没有该参数"和"参数为空字符串"语义不同（空显示名会关掉群 @ 识别，而不是回落到默认值）。

### D2 后端是唯一的控制面

没有新增 API。既有的 `PATCH /api/agents/:id { lark: { enabled } }` 就是开关：

| 操作 | 后端 | platform |
|---|---|---|
| 启用 | `ensureLarkBot` 写 env + `systemctl start` | 单元进入 active |
| 停用 | `stopLarkBot` | `systemctl stop` → inactive |

`start` 是幂等的：已经 active 就什么都不做，所以 **backend 重启不会打断已连接的机器人**——这正是搬家要解决的问题。

### D3 状态 = 心跳优先，进程状态兜底

机器人本来就每几秒 POST 一次心跳（`/api/internal/surfaces/lark/heartbeat`），后端存 `{status,lastSeenAt,lastError}`。

`statusOf(agentId)`：

1. 心跳在 **90 秒**内 → 用它（`error`/`degraded`/`running`）；
2. 否则用 `systemctl is-active`（5 秒轮询、结果缓存，因为 DTO 里的 status 是同步读取的）：单元 active 但没心跳 → **`configured`**（进程在、还没听到它说话），**不谎称 running**；
3. 都没有 → `configured`。

**通式：能证明"在工作"的证据（心跳）比"存在"的证据（进程）强，状态要按强的那个报。**

### D4 dispose 不停单元

backend 退出时**不** stop 单元：重启 backend 不应让机器人重连。只有"用户在应用里关掉"才停。

### D5 单元必须显式给 HOME

systemd 对"没有写 `User=` 的单元"**不设置 HOME**。而 `lark-cli` 靠 `~/.lark-cli/config.json` 找 profile：没有 HOME 时它报 `not_configured`（还附带一句误导性的"run config init --new"）。

真机上这条的形态最容易误判：**手工在 shell 里跑同一条命令成功，机器人里每条投递都失败**，卡片停在"排队/creating"。两个单元（backend 与 bot）都显式写 `Environment=HOME=/root`。

**通式：单元里凡是要 shell-out 到读用户目录的工具（credential 文件、缓存），都要显式给 HOME——"我手工跑得通"不是证据。**

### D6 选择用显式开关

`LARK_BOT_SUPERVISOR=systemd`（写在后端单元里）。没装模板单元的开发机保持子进程模式，行为不变。没有自动探测：自动选择会让"为什么这台机器上是另一种行为"变成一个谜。

## 不变量

1. 开关只有一个入口：agent 的 `lark.enabled`。不允许 `systemctl` 与应用状态各自为政。
2. env 文件 0600，且是**唯一**被 systemd 读取的凭据来源（argv 不出现 token）。
3. 状态不得把"进程活着"说成"在监听"。
4. 后端重启不改变机器人连接。

## 落点

| 层 | 文件 |
|---|---|
| 单元 | `/etc/systemd/system/my-agent-team-{backend,web}.service`、`my-agent-team-lark-bot@.service` |
| 启动器 | `scripts/lark-bot-unit.sh` |
| 控制器 | `apps/backend/src/features/lark-bot/systemd-registry.ts`（+ 测试）、工厂分支 `lark-bot-registry-factory.ts` |
| 心跳→状态 | `apps/backend/src/bootstrap/services.ts`（`heartbeatOf` → `opsStore`） |
| 开关 | `packages/config/src/env.ts`（`LARK_BOT_SUPERVISOR`）、后端单元的 `Environment=` |
| 单元环境 | `deploy/systemd/*.service`（`HOME`、`PATH`）与 `apps/backend/.env`（provider key，见指南） |

## 验收

1. ✓ 启动写 0600 的 env 文件并 `systemctl start`（变异：改成 0644 → 红）。
2. ✓ 缺省显示名**不写** `LARK_BOT_DISPLAY_NAME=`（空值语义不同）。
3. ✓ 心跳新鲜时以心跳为准，`error` 心跳压过活着的进程（变异：恒返回 running → 红）；心跳过期回落到进程状态。
4. ✓ 单元名从 agentId 推导，含 shell 元字符的 id 直接拒绝。
5. ✓ 真机：`PATCH {enabled:false}` → 单元 `inactive`、`status: not_configured`；`PATCH {enabled:true,…}` → 单元 `active`、`status: running`；后端 cgroup 里**没有**机器人子进程；`journalctl -u my-agent-team-lark-bot@default` 显示 `channel connected app=cli_aa3e242e58781bee`。
6. ✓ 重启 backend 后机器人 PID 不变（D4：3930492 → 3930492）。
7. ✓ 单元内 `HOME=/root`；真机投递成功（平台侧可见机器人发出的"投递正常"）。
