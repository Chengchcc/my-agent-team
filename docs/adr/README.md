# ADR 索引

决策记录的**唯一目录**。架构级规则文档(design-philosophy / e2e-contract-rules / db-typesafe-rules)与协议实测记录(gate0)仍在 `docs/architecture/`，见文末链接。

**状态图例**：Accepted=现行有效；Implemented=已实施；Superseded=被后续迭代取代(仅历史)；Deferred=维持不做；Obsolete=对象已移除；被取代/目标达成=以不同形态落地。

| # | 标题 | 状态 |
|---|---|---|
| 0001 | loop-prune-is-post-processing | **Obsolete**（Loop 已删，2026-08-28） |
| 0002 | config-generation-is-builtin-skill | **Obsolete**（Loop 配置生成随 Loop 删除） |
| 0003 | state-md-single-writer | **Obsolete**（STATE.md 状态机随 Loop 删除） |
| 0004 | discovery-is-agent-session | **Obsolete**（指向的 ADR 0025 triage workflow 也随 Loop 删除） |
| 0005 | mcp-deferred-for-loop | **Obsolete**（Loop 已删；MCP 另见 0012/0022） |
| 0006 | loop-lock-deferred | **Obsolete**（Loop 已删；worktree 互斥另见 0023 workspace-lock） |
| 0007 | span-canonical-run-user-facing | **Superseded**(span 已删，Phase 6) |
| 0008 | collapse-harness-invocation-layer | **Superseded**（删掉的层确实删了，但它新建的 plugin-trace / conversation_session / SpanSupervisor 后来全部删除） |
| 0009 | session-layer-owns-identity-features-own-binding | **Superseded**(framework 已删) |
| 0010 | typed-context-keys | **Superseded**(未采纳，引擎已重建) |
| 0011 | web-ia-work-chat-team | **部分实现**（四组导航与「一件事一个家」的 IA 骨架仍在：`NavRail.tsx` + `(main)/{today,coding,workflows,artifacts,chat,team,system}`；正文的 Loop 词汇表随 Loop 删除作废，`/work` 已改名 `/today`） |
| 0012 | mcp-client-architecture | Accepted（实现形状与正文不同：catalog 是文件，无 per-agent 表；真实工具注入走 `.mcp.json` + 子进程每 run connect，`McpClientManager.getTools()` 已无调用者） |
| 0013 | memory-plugin | **被取代**(功能吸收进 workspace 文件模型) |
| 0014 | compaction-quality | **部分实现**（只有 token 预算切点落地；8 段式摘要 prompt 与迭代更新没有实现） |
| 0015 | autonomous-memory | **部分实现**（记忆以 `.oma/memory/*`（facts/memory_summary.md/MEMORY.md）+ `learn` 工具 + 系统提示注入的形态落地；正文的「去掉 learn 工具」与 `.memory_state.json` 与实现不符；backend 记忆面板读写 `<workspace>/memory/*`，与 agent 的 `.oma/memory/*` 不是同一个目录） |
| 0016 | agent-runtime | **Superseded**（`packages/agent` 与 `createAgentSession()` 都不存在） |
| 0017 | canonical-message-contract | Accepted（协议层 schema 不表达「assistant 禁 tool_result」，anthropic 存量混血的拆解防御未实现） |
| 0018 | multi-api-provider-architecture | Accepted |
| 0019 | cli-session-dual-truth(运行态/产品态双轨) | Accepted（「双轨」提法已收成单轨：共用分支上的 `cli_session_ref`） |
| 0020 | agent-workspace-and-resource-bridge | Accepted（三处未落地：manifest.json 资源索引整节 absent、workspace seed 无 USER.md 与 memory/、§4 的 skillRoots 移除未做；手改 agent.yml 不回读） |
| 0021 | one-conversation-one-agent-member(session 投影) | Accepted（决策 4 的 thingRef 全仓零命中） |
| 0022 | mcp-catalog-and-knowledge-packs | Accepted（catalog 改成文件；但迁移 0027 只把 `mcp_server` 改名为 `mcp_server_legacy`、未 DROP，存量提升无生产调用者（`mergeMcpCatalog` 是死代码）；空 knowledge 包仍会写 index.md） |
| 0023 | project-worktree-workspace(多对多 worktree 桥接) | Accepted（P1、P2 与任务轴附录均已实现） |
| 0024 | oma-wire-protocol-fixture-contract | Accepted |
| 0025 | loop-workflow-first-execution(Workflow 一等执行) | **Obsolete**（Loop 已删；Workflow DSL 作为独立功能继续存在） |
| 0026 | agent-threat-model | Accepted（限流已实现，但是有意的全局单桶、不是按 IP，见 `apps/web/src/app/api/auth/login/route.ts` 的注释；三条未决项仍未做） |
| 0027 | ask-question-product-tools-mcp(跨 runtime HITL 提问) | Accepted（四端都拿到 `ask_question`；两处漂移：ask 已落 `pending_action` 行、超时默认 24h（`BACKEND_ASK_TIMEOUT_MS`），正文的「不建新表 / 60s」已过期） |
| 0028 | tui-component-layering(live 归 chrome，终局归 transcript) | Accepted |
| 0029 | coding-agent-status-contract(agent-status 文件契约接受双写重复) | Accepted（正文的「两份测试文件」不实：只有 writer 侧 `modes/tui/agent-status.test.ts`，reader 侧无测试） |
| 0030 | control-plane-positioning(产品定位四边界) | Accepted |
| 0031 | lark-run-card-transient-projection(Run 卡片临时投影) | **Implemented**（第一期 + 2026-09-24 追加：卡片按钮回调（停止/审批/追问选项）、过程视图、todo 计划条、跨端共享 `OmaTodoItem`；2026-09-28 修订：追问的自由文本表单已落地，reaction 触发与多选取值仍未做） |
| 0032 | lark-final-delivery-at-least-once(终态投递 at-least-once) | Implemented |
| 0033 | tool-activity-boundary(工具活动行是唯一跨进程的展示字段) | **Implemented**（决策 2 有例外：审批帧会把原始 input 发出——人要看到批的是什么，见 `rpc-mode.ts` 的 `rpcApproval`；`mapping.ts` 的 default 分支也会透传未收窄字段） |
| 0034 | lark-access-tiers(飞书访问控制分层：群准入、发送者名单、@ 判定) | Implemented |
| 0035 | lark-instant-ack-reaction(收到即挂 emoji 回执，封版换成 DONE) | Implemented |
| 0036 | product-tool-identity-from-token(身份取自 run token，模型参数不参与授权) | Implemented |
| 0037 | lark-topic-as-conversation(话题 = 会话边界；回答回复进话题；话题内排队；私聊由卡片建话题) | **Implemented**（话题绑定、回帖、排队卡、私聊建话题均已落地；决策 8 的「复用 run_card、不新建表」被 `topic_binding` 表取代） |
| 0038 | hitl-run-resume-after-restart(停靠 HITL 的 Run 重启后可恢复：实时落盘 + 停靠标记 + 决定注入) | **Implemented**（两条 partial：决策 4 的「审批超时收尾」与决策 7 的「CLI 侧带 session 引用续跑」在重启后的停靠 run 上不成立） |
| 0039 | approval-request-is-a-product-contract(审批请求是产品的一等契约；ACP 为目标传输，分相落地) | **Accepted**（决策 1 至 7 已落地；P1 acp kind 与 P2 oma 的 ACP 面已隔离栈真机验收，含审批、恢复、steering、mcp-over-acp；P3 至 P5 待做。surface 侧的收敛见 0040） |

> 状态翻转纪律：任何 ADR 状态变更(Obsolete/Superseded/Deferred→Implemented 等)**必须同 PR 更新本索引**，避免索引与正文失配(2026-08-21 修复 0004/0006/0024 时立规)。

## 2026-09-28 实现复核

按「每条决策一行、证据到 `path:symbol`」对全部现行 ADR 复核了一遍实现程度（5 组并行只读审查）。上面 13 行的备注由这次复核改写，其余条目与实情相符。几处值得单独记下的：

- **0015 的记忆目录不一致**（像 bug）：backend 记忆面板读写 `<workspace>/memory/*`（`features/agent/http.ts`、`infra/workspace.ts` 还专门建这个目录），而 agent 的记忆写入与注入读的都是 `.oma/memory/*`（`core/memory/autonomous-memory.ts`、`core/runtime/prompts.ts`）。也就是说面板显示的是 agent 从不写入的目录。
- **0022 的「表已删」不成立**：迁移 `0027_mcp_catalog.sql` 只 `RENAME TO mcp_server_legacy`，全仓没有 DROP；它承诺的「存量提升」也没有生产调用者（`features/mcp/adapter-file.ts` 的 `mergeMcpCatalog` 是死代码）。
- **0012 的进程内缓存已被取代**：`packages/adapter-mcp/src/mcp-client-manager.ts` 的 `getTools()` 全仓无调用点，真实注入由 `writeMcpConfig` 写 `.mcp.json` + `core/tools/mcp-mount.ts` 每 run connect 完成。
- **0033 的边界例外**：原始 tool input 只保证在 `tool_execution_start` 上被 `forWire` 剥掉；审批帧必须带 input 才能让人看清批的是什么，这是一条有意的例外，正文没写。
- **0024 的注释过期**：`apps/oh-my-agent/src/{protocol,event-mapper}.ts` 里仍写「Lives in the CONTRACT package (agent-backend)」，而 wire schema 已回到 oma/adapter 两侧，`agent-contract` 只剩 backend-agnostic 契约。

## 架构级决策文档(非 ADR，但同属决策面)

- `docs/architecture/design-philosophy.md` — 8 条架构原则
- `docs/architecture/e2e-contract-rules.md` — 跨进程类型契约规则
- `docs/architecture/db-typesafe-rules.md` — DB 类型链规则
- `docs/architecture/execution/backend-kinds-gate0.md` — 多 backend 协议实测记录(决策见 §7)
| 0040 | run-contract-acp-surface-contract-ahp(运行契约归 ACP、surface 契约归 AHP；两条自研方言下线，删除清单即验收条件) | **Accepted**（S0 首刀已落地：ACP 轨的工具事实进账本，验收向量绿；规范模型其余部分与 S1 至 S3、R1 至 R3 待做。工作分支 feat/ahp2acp） |
| 0041 | conversation-membership-and-response-routing(会话成员 1..N、响应路由由成员数派生；部分取代 0021) | **Proposed**（初稿 2026-10-03；实现未开始——迁移/路由/Web/Lark 四步待排） |
| 0042 | workflow-rework-as-new-attempts(返工 = 新的尝试，不是环：rework 边 + 预算，图仍无环) | **Implemented**（2026-10-10 落地：P1 至 P5 全部实现并各带测试；rework 与预算门的 grant/reject 已真机验证，见 #79） |
| 0043 | embedding-engine-shared-package(把本地向量引擎抽成包：引擎共享、策略各自拥有；后端语义检索走 provider-API，不走按平台打包) | **部分实现**（2026-10-13：第一步纯搬迁 + 决策 2 的两条入口均已落地——`packages/embedding` 核心零原生依赖、`/fastembed` 子路径才带 ONNX 且由打包级测试钉住；顺带补上 `RetainInput.validUntil`。**决策 7 已实现但默认关闭**：embedding 缝、向量索引（全有或全无 + 内容签名判失效 + 段落切块）、查询降级（无索引/建不起来时退回词法并说明原因）、播种与索引解耦都已落地并测试；本机实测 39 页 = 1547 块、每块 11～20 秒 ⇒ 全量构建 5～7 小时 ⇒ 默认不配 `BACKEND_EMBEDDING_*`，行为与今天逐字一致，换到便宜的机器即可打开） |
| 0044 | lark-inbound-events-official-channel-sdk(入站事件层换官方 channel SDK；评论线＝会话作用域，边界用两个适配器收住) | **部分实现**（2026-10-14：决策 1 至 6、8、9 已落地——官方 SDK 接管长连接、两个边界适配器、评论线＝会话（合成 chatId）、按文档订阅、@ 与 agent 来源双闸、回答回进同一条评论线；生产 bot 已重启并连上，`lark-cli` 总线与消费者消失。决策 7 的后端一半（`larkSetupGuidance`）已进 surface 视图，Web 渲染待做；决策 10 的隔离 app 端到端验收待做） |
| 0045 | parallel-waves-and-all-join(波次并行与 all-join) | **Implemented**（2026-10-19 落地并带变异验证钉子） |
| 0046 | ambient-rules-proactive-spine(环境规则：observe 缝上的规则升格，super-agent 主动脊柱第一刀) | **Implemented**（record/act 两档、`proactive_event` 台账、lark source 经 wire 传递；多成员与图片输入不参与，见正文边界） |
| 0047 | room-dispatch(房间内派单：dispatch 产品工具 + 授权依据入 Run 快照 + 环境规则指派目标，领班/工人第一刀) | **Implemented**（迁移 0059、排队晋升保真、变异验证四钉；模型研判与池化调度在 roadmap） |
| 0048 | semantic-assessment(语义研判与能力卡：观察缝模型研判 observe/auto、agent skills、team_list，主动脊柱第三刀) | **Implemented**（异步研判不阻塞 POST、失败退 error 事件、拒绝不记账；A2A 语义对齐表见正文） |
| 0049 | front-desk-invariant(前台不变量：人工输入永不直接命令工人，worker 角色重路由到会话前台) | **Implemented**（判据=授权依据 user；创建守卫拒 worker 绑会话；服务端依据直达工人不受影响；2026-11-13 补充：worker 与 lark 互斥在 schema 层拒绝、ZodError→400） |
| 0050 | web-topology-presentation(Web 端的前台/工人呈现：分区团队页、角色感知卡片与表单、人面选择器过滤工人) | **Implemented**（纯渲染层，零后端改动——DTO 已带 role/skills/description） |
