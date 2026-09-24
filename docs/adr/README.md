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
| 0011 | web-ia-work-chat-team | **Implemented** |
| 0012 | mcp-client-architecture | Accepted（实现形状与正文不同：catalog 是文件，无 per-agent 表） |
| 0013 | memory-plugin | **被取代**(功能吸收进 workspace 文件模型) |
| 0014 | compaction-quality | **部分实现**（只有 token 预算切点落地；8 段式摘要 prompt 与迭代更新没有实现） |
| 0015 | autonomous-memory | **目标达成**(workspace 文件形态，机制被取代) |
| 0016 | agent-runtime | **Superseded**（`packages/agent` 与 `createAgentSession()` 都不存在） |
| 0017 | canonical-message-contract | Accepted |
| 0018 | multi-api-provider-architecture | Accepted |
| 0019 | cli-session-dual-truth(运行态/产品态双轨) | Accepted（「双轨」提法已收成单轨：共用分支上的 `cli_session_ref`） |
| 0020 | agent-workspace-and-resource-bridge | Accepted |
| 0021 | one-conversation-one-agent-member(session 投影) | Accepted |
| 0022 | mcp-catalog-and-knowledge-packs | Accepted（catalog 改成文件，`mcp_server` 表已删） |
| 0023 | project-worktree-workspace(多对多 worktree 桥接) | Accepted（P1、P2 与任务轴附录均已实现） |
| 0024 | oma-wire-protocol-fixture-contract | Accepted |
| 0025 | loop-workflow-first-execution(Workflow 一等执行) | **Obsolete**（Loop 已删；Workflow DSL 作为独立功能继续存在） |
| 0026 | agent-threat-model | Accepted（正文的「按 IP 限流」一句没有实现） |
| 0027 | ask-question-product-tools-mcp(跨 runtime HITL 提问) | Accepted（四端 runtime 都已经 Product Tools MCP 拿到 `ask_question`） |
| 0028 | tui-component-layering(live 归 chrome，终局归 transcript) | Accepted |
| 0029 | coding-agent-status-contract(agent-status 文件契约接受双写重复) | Accepted |
| 0030 | control-plane-positioning(产品定位四边界) | Accepted |
| 0031 | lark-run-card-transient-projection(Run 卡片临时投影) | **Implemented**（第一期 + 2026-09-24 追加：卡片按钮回调（停止/审批/追问选项）、过程视图、todo 计划条、跨端共享 `OmaTodoItem`；reaction 与自由文本表单未做） |
| 0032 | lark-final-delivery-at-least-once(终态投递 at-least-once) | Implemented |
| 0033 | tool-activity-boundary(工具活动行是唯一跨进程的展示字段) | Implemented |
| 0034 | lark-access-tiers(飞书访问控制分层：群准入、发送者名单、@ 判定) | Implemented |
| 0035 | lark-instant-ack-reaction(收到即挂 emoji 回执，封版换成 DONE) | Implemented |
| 0036 | product-tool-identity-from-token(身份取自 run token，模型参数不参与授权) | Implemented |

> 状态翻转纪律：任何 ADR 状态变更(Obsolete/Superseded/Deferred→Implemented 等)**必须同 PR 更新本索引**，避免索引与正文失配(2026-08-21 修复 0004/0006/0024 时立规)。

## 架构级决策文档(非 ADR，但同属决策面)

- `docs/architecture/design-philosophy.md` — 8 条架构原则
- `docs/architecture/e2e-contract-rules.md` — 跨进程类型契约规则
- `docs/architecture/db-typesafe-rules.md` — DB 类型链规则
- `docs/architecture/execution/backend-kinds-gate0.md` — 多 backend 协议实测记录(决策见 §7)
