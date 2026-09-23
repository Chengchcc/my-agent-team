# Lark Run 卡片：Run 的临时呈现层，终态以 canonical Message 封版

M17 曾把流式卡片整体移除，收敛到「ledger 是 assistant 消息唯一权威出口」的纯文本终态桥。产品定位（ADR 0030）要求 Lark 成为 Run 的远程镜像而非终态转发器：派活后立刻出现执行卡片、过程持续更新、可停止/审批/回答追问。本 ADR 记录回加卡片时的边界，使它不翻 M17 的旧案。

## 决策

1. **卡片是 Run 的 transient 投影。** 消费 Run SSE（status / text_delta / tool 事件 / approval_request / ask_requested），绑定 runId → larkMessageId，状态机 `creating → streaming → waiting_approval | waiting_input → completed | failed | cancelled`。卡片渲染用「reducer（事件归约成纯状态）与 renderer（状态渲染成卡片）分离」的形状；更新经单飞 flush 控制器（合并 delta、PATCH 互斥、结束后不再刷）。
2. **token delta 不持久化。** 可靠性分层：text_delta 可少量丢帧；卡片状态尽量及时；**终态必须可靠**；审批与追问必须可靠可恢复；Conversation 历史由 canonical Message 统一保存。卡片 PATCH 失败不阻塞 Run，下一次 delta 继续补。
3. **终态封版用同一张卡（方案 A）。** completed/failed 时以 backend 提交的 canonical assistant Message 覆盖卡片正文，不另发一条对等的终态消息；卡片终态更新失败才降级发纯文本。理由：用户不会看到「过程一张卡 + 结论一条消息」的重复，runId → cardMessageId 关系单一，卡片是 Run 的完整 UX 生命周期。
4. **卡片状态留在端侧。** 投递状态表（LarkRunCard：message id、PATCH 游标、状态）存 lark-bot 本地 SQLite，与 chat_binding / message_delivery 同层。不为卡片在 backend 新建领域实体（无 LarkMessage / CardMessage / StreamMessage）。
5. **节流与截断。** 200–500ms 或累计 100–300 字符合并一次 PATCH，终态立即；正文只保留最近约 8–12k 字符，超出提示「完整过程请在 Web 查看」——飞书卡片有大小上限，塞满会导致整卡更新失败。
6. **控制动作走 backend 现有 Run 控制接口。** 停止 = `POST /api/agent-runs/:runId/cancel`（幂等），审批 = `/approval`；lark-bot 校验操作者身份与 chat↔run 绑定后转发。授权与验签机制（如签名 callback token）归 backend 持有，lark-bot 不自持信任；第二期引入时细节另记。
7. **工具只显示摘要。** 当前工具一句摘要 + 历史工具数量与名称；原始工具输出不进群聊，详情走 Web 深链。

## 与 M17.5 收敛的关系

ledger 仍是 assistant 消息的唯一权威出口——卡片只消费 transient Run SSE 与终态 canonical Message，**不构成第二条消息真相**。这是回加卡片不翻旧案的原因：M17 删的是「卡片自己维护流式消息事实」，本 ADR 加的是「Run 的呈现投影」。

## 后果

- 实施时 `apps/lark-bot/src` 按 inbound / conversation（终态投递）/ run-card（流式与控制）/ storage / lark-api 分组，终态投递与卡片 PATCH 的故障语义不得混在同一模块；backend `features/lark-bot` 随本期改名 `lark-surface`（它管 surface 生命周期与 registry，不是 bot 业务实现）。
- 第一期必须与终态可靠投递（ADR 0032）同切片交付：只有流式而没有可靠终态，用户看得到过程却收不到结论。
