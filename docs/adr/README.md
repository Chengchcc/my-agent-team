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
| 0039 | approval-request-is-a-product-contract(审批请求是产品的一等契约；各后端薄适配；ACP 传输统一留作副产品) | **Accepted**（决策 1 已落地；四个后端适配待做） |

> 状态翻转纪律：任何 ADR 状态变更(Obsolete/Superseded/Deferred→Implemented 等)**必须同 PR 更新本索引**，避免索引与正文失配(2026-08-21 修复 0004/0006/0024 时立规)。

## 2026-09-28 实现复核

按「每条决策一行、证据到 `path:symbol`」对全部现行 ADR 复核了一遍实现程度（5 组并行只读审查）。上面 13 行的备注由这次复核改写，其余条目与实情相符。几处值得单独记下的：

- **0015 的记忆目录不一致**（像 bug）：backend 记忆面板读写 `<workspace>/memory/*`（`features/agent/http.ts`、`infra/workspace.ts` 还专门建这个目录），而 agent 的记忆写入与注入读的都是 `.oma/memory/*`（`core/memory/autonomous-memory.ts`、`core/runtime/prompts.ts`）。也就是说面板显示的是 agent 从不写入的目录。
- **0022 的「表已删」不成立**：迁移 `0027_mcp_catalog.sql` 只 `RENAME TO mcp_server_legacy`，全仓没有 DROP；它承诺的「存量提升」也没有生产调用者（`features/mcp/adapter-file.ts` 的 `mergeMcpCatalog` 是死代码）。
- **0012 的进程内缓存已被取代**：`packages/adapter-mcp/src/mcp-client-manager.ts` 的 `getTools()` 全仓无调用点，真实注入由 `writeMcpConfig` 写 `.mcp.json` + `core/tools/mcp-mount.ts` 每 run connect 完成。
- **0033 的边界例外**：原始 tool input 只保证在 `tool_execution_start` 上被 `forWire` 剥掉；审批帧必须带 input 才能让人看清批的是什么，这是一条有意的例外，正文没写。
- **0024 的注释过期**：`packages/adapter-oma-agent/src/{protocol,event-mapper}.ts` 里仍写「Lives in the CONTRACT package (agent-backend)」，而 wire schema 已回到 oma/adapter 两侧，`agent-contract` 只剩 backend-agnostic 契约。

## 架构级决策文档(非 ADR，但同属决策面)

- `docs/architecture/design-philosophy.md` — 8 条架构原则
- `docs/architecture/e2e-contract-rules.md` — 跨进程类型契约规则
- `docs/architecture/db-typesafe-rules.md` — DB 类型链规则
- `docs/architecture/execution/backend-kinds-gate0.md` — 多 backend 协议实测记录(决策见 §7)
