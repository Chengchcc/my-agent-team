# Lark Run 卡片：Run 的临时呈现层，终态以 canonical Message 封版

M17 曾把流式卡片整体移除，收敛到「ledger 是 assistant 消息唯一权威出口」的纯文本终态桥。产品定位（ADR 0030）要求 Lark 成为 Run 的远程镜像而非终态转发器：派活后立刻出现执行卡片、过程持续更新、可停止/审批/回答追问。本 ADR 记录回加卡片时的边界，使它不翻 M17 的旧案。

## 决策

1. **卡片是 Run 的 transient 投影。** 消费 Run SSE（status / text_delta / tool 事件 / approval_request / ask_requested），绑定 runId → larkMessageId，状态机 `creating → streaming → waiting_approval | waiting_input → completed | failed | cancelled`。卡片渲染用「reducer（事件归约成纯状态）与 renderer（状态渲染成卡片）分离」的形状；更新经单飞 flush 控制器（合并 delta、PATCH 互斥、结束后不再刷）。
2. **token delta 不持久化。** 可靠性分层：text_delta 可少量丢帧；卡片状态尽量及时；**终态必须可靠**；审批与追问必须可靠可恢复；Conversation 历史由 canonical Message 统一保存。卡片 PATCH 失败不阻塞 Run，下一次 delta 继续补。
3. **终态封版用同一张卡（方案 A）。** completed/failed 时以 backend 提交的 canonical assistant Message 覆盖卡片正文，不另发一条对等的终态消息；卡片终态更新失败才降级发纯文本。理由：用户不会看到「过程一张卡 + 结论一条消息」的重复，runId → cardMessageId 关系单一，卡片是 Run 的完整 UX 生命周期。
4. **卡片状态留在端侧。** 投递状态表（LarkRunCard：message id、PATCH 游标、状态）存 lark-bot 本地 SQLite，与 chat_binding / message_delivery 同层。不为卡片在 backend 新建领域实体（无 LarkMessage / CardMessage / StreamMessage）。
5. **节流与截断。** 200–500ms 或累计 100–300 字符合并一次 PATCH，终态立即；正文只保留最近约 8–12k 字符，超出提示「完整过程请在 Web 查看」——飞书卡片有大小上限，塞满会导致整卡更新失败。
6. **控制动作走 backend 现有 Run 控制接口；卡片按钮回调经 lark-cli 的 `card.action.trigger` 事件（2026-09-24 修订：lark-cli ≥1.0.9x 已暴露该 EventKey，走同一出站长连接，无需公网 ingress——初版「不可达」的结论基于 1.0.53 旧版 CLI，作废）。** 已实现：卡片「停止」按钮（Card JSON 2.0 button + `behaviors:[{type:"callback",value:{runId,action:"stop"}}]`）→ lark-bot 消费回调 → 校验（event_id 去重、message_id↔run_card 映射、chat/run 匹配；action_value 永不单独被信任）→ `POST /api/agent-runs/:runId/cancel`（幂等）→ Run SSE 的 cancelled 终态把卡片封灰。`/stop` 入站命令保留为等价通道（成功即沉默，卡片即反馈）。审批/拒绝/回答的按钮与表单是同一机制的直接扩展；多操作者部署需补签名 action token（runId+chatId+messageId+action+expiry+nonce，backend 签发与验签）与 backend 侧 event_id 去重，本 ADR 预留该缝。
7. **工具只显示摘要。** 当前工具一句摘要 + 历史工具数量与名称；原始工具输出不进群聊，详情走 Web 深链。
8. **与文本桥的去重缝：messageId 自带 runId。** assistant 账本行的 messageId 形如 `run:<runId>:assistant:<ordinal>`（`assistantMessageId()`），sse-watcher 投递前解析它：若该 (runId, chat) 存在非终态且未 fallback 的卡，跳过文本发送、只推游标——封版责任在卡片 watcher（它同时消费 Run SSE 与 canonical 终态，封版 PATCH 耗尽后自己发降级纯文本并把卡标 `fallback_text`）。卡片在 ingest 返回 triggeredRuns 后立即创建，早于任何 canonical 消息出现，顺序竞态天然安全。不需要 backend 任何配合。
9. **卡片热路径直连 CardKit OpenAPI，lark-cli 只管凭据/入站/普通文本（2026-09-24）。** 逐字流式 = CardKit 卡片实体 + `PUT /cards/:id/elements/:element_id/content`（累计全文 + 严格递增 sequence，客户端对前缀扩展做打字机动画）；header 变化与终态 = 全卡替换（`PUT /cards/:id`），流式结束后必须 `PATCH /cards/:id/settings` 关闭 streaming_mode 客户端才离开流式视图。lark-bot 内的 tenant token 由 `lark-api.ts` 从 lark-cli 本地密钥库（`~/.local/share/lark-cli/appsecret_<appId>.enc`，AES-256-GCM + master.key）解出 secret 自行铸造并缓存——不逐调用 spawn CLI。实测约束：幂等键 ≤50 字符（哈希成 40 位十六进制）；`body.elements` 只认元素标签（`plain_text` 是文本对象标签，200621 整卡拒绝）；**每应用卡片实体绑定数有配额**（200780，测试中约 18 张触发），长期运行需关注或配额度管理。

## 与 M17.5 收敛的关系

ledger 仍是 assistant 消息的唯一权威出口——卡片只消费 transient Run SSE 与终态 canonical Message，**不构成第二条消息真相**。这是回加卡片不翻旧案的原因：M17 删的是「卡片自己维护流式消息事实」，本 ADR 加的是「Run 的呈现投影」。

## 后果

- 实施时 `apps/lark-bot/src` 按 inbound / conversation（终态投递）/ run-card（流式与控制）/ storage / lark-api 分组，终态投递与卡片 PATCH 的故障语义不得混在同一模块；backend `features/lark-bot` 随本期改名 `lark-surface`（它管 surface 生命周期与 registry，不是 bot 业务实现）。
- 第一期必须与终态可靠投递（ADR 0032）同切片交付：只有流式而没有可靠终态，用户看得到过程却收不到结论。
- 卡片交互的第一载体不是按钮回调，这同时是优点：零新增公网暴露面（与 ADR 0026 单用户本地边界一致）；代价是交互表现力受限（reaction/命令 vs 多按钮表单），审批与追问的卡片内表单推迟到回调通道可用之后。
