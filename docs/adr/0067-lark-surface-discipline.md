# ADR 0067: Lark 面三条纪律 —— 私聊平铺、陌生人来要申请、卡片主机由 Web 配

- 状态: Accepted
- 日期: 2026-11-19
- 相关: ADR 0037（话题路由）、ADR 0041（三层准入）、ADR 0049（前台不变量）、ADR 0066（会议室/展厅）

## 背景

运营者真机跑通一条 DM 之后，提了四条要求，其中三条改行为、一条是配置项：

1. **私聊不要话题回复**。此前私聊的答案也走 `reply_in_thread`，而 Lark 在私聊里回一条 thread 就给这个会话**永久**建出一个话题树——DM 变成"每个答案各占一个话题"的样子。
2. **群里谁 @ 都行**（保持 `groupPolicy: open`），但**陌生人私聊要先申请**。
3. 卡片里的链接**保持现状**（`localhost:3001`）。
4. 但**要在 Web 里能配一个 host**——"我的机器能访问到哪个地址"是部署事实，不是构建期事实。

## 决策

### D1 只有话题群才用话题回复

`replyInThreadFor(chatMode)` 从 `chatMode !== "group"` 改成 `chatMode === "topic"`。

- **话题群**（`chat_mode: "topic"`）：必须 thread 回复，否则答案落在主流里，不在会话的话题中。
- **私聊**（`p2p`）：平铺。thread 回复会**创建**话题，而话题一旦建出来撤不掉——这是"制造了就不能回退"的那类状态，默认不做。
- **普通群**（`group`）：没有话题可加入，平铺。
- **未知**（`null`，查询失败）：平铺。理由同上：平铺可以重发到话题里，误建的话题撤不掉。

### D2 陌生人的私聊是一次"申请"，不是被无视

准入仍在 `decideInbound`（纯函数）里，`dm_denied` 不变；**后果**变了：

- 首次：给申请人回一句"已转给管理员"，并给每一位 owner 发一条私信，内容是这个人 + 两行可复制指令 `/approve ou_…` / `/deny ou_…`。
- 重复：同一个人只通知一次（`created: false`），否则机器人变成门铃。
- 已拒绝的人再发：**仍是拒绝**，不再打扰 operator。要不要重启需要 operator 自己决定。
- owner 的 `/approve` 在 **ingest 的准入之后、agent 轮次之前**拦截——它是管理动作，不是提示词。owner 的定义是 `allowedSenders` 里的**具体 id**；`"*"` 表示"谁都能跟它说话"，**不**表示"谁都能授权"。
- 批准会写回 agent 的 `allowedSenders`（后端 PATCH），所以下一次消息走正常准入；`access_request` 行留作审计与去重。

**为什么用文本指令而不是卡片按钮**：授权是安全边界，能承载它的最小面胜出。按钮要在同一个 `open_id` 参数前多一层卡片渲染 + 动作解码 + 新动作类型；文本指令把面收在 `parseOwnerCommand` 一个纯函数里，且必须整行匹配（"请 /approve … 一下"不是指令）。

### D3 卡片主机由 Web 配置

`lark.web_url` 进 agent 配置（schema + DTO + PATCH body + `agent.yml`），Web 的 Lark 面板加一个 "Card link host" 输入框。bot 每条消息都会拉 agent 配置（既有行为），顺手记下 `webUrl` 给卡片用；**启动参数 `--web-url` 只是兜底**，因为配置是运营者能改的那一份。

卡片链接默认行为不变（D3 只加可配置性，不改现网表现）。

## 不变量

1. 私聊不创建话题；话题群里的答案必须落在话题内。
2. 未授权的人**不能**通过任何路径驱动 agent；`/approve` 只对 owner 生效。
3. 一次决定只有一次：已决定的申请不能被后来的点击/重复命令改写。
4. 陌生人的重复消息不重复打扰 operator。

## 落点

| 层 | 文件 |
|---|---|
| 私聊平铺 | `apps/lark-bot/src/topic-routing.ts`（`replyInThreadFor`） |
| 申请/授权 | `apps/lark-bot/src/access-requests.ts`（纯）、`bindings-sqlite.ts`（表 + 三函数）、`db/schema.ts`、`drizzle/0011_*`、`ingest.ts`（拦截与 decision 后果）、`main.ts`（发信、写白名单） |
| 卡片主机 | `apps/backend/src/features/agent/{agent-config,http}.ts`（`web_url`）、`apps/web/src/features/lark/LarkSurfacePanel.tsx`、`ingest.ts`（每条消息记录）→ `main.ts`（`cardHost`） |
| 发给个人 | `apps/lark-bot/src/lark-send.ts`（`--user-id` 通道，owner 可能还没有 p2p 会话） |

## 验收

1. ✓ `replyInThreadFor`: topic=true、p2p=false、null=false、group=false（变异：改回 `!== "group"` → 红）。
2. ✓ 被拒的私聊产生一次 `onAccessRequested`；owner 的 `/approve` 被当作管理动作消费掉（不触发 run）。
3. ✓ 陌生人发 `/approve` **不是** owner：不执行、按普通被拒私聊处理（变异：去掉 owner 判断 → 红）。
4. ✓ 申请只通知一次；决定单向（变异：去掉 pending 判断 → 红）。
5. 待真机：Web 里填 host 后，新卡片链接使用它。
