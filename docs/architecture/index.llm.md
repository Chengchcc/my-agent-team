# LLM 入口索引

当一个 LLM 需要回答关于 `my-agent-team` 架构的问题时，先读这个文件，再按下面的「问题类型 → 该读哪几页」去取对应正文。每一页正文都基于真实代码撰写，frontmatter 里的 `summary` 与 `depends_on` / `used_by` 可用于快速判断相关性。

> 例外：`status: design` 的页面描述的是**已锁定但尚未进代码**的设计抽象（如 `foundations/issue.md`、`backend/orchestrator.md`）。回答现状问题时不要把它们当成当前行为；可凭 frontmatter 的 `status` 字段区分。

## 如果问的是整个系统怎么运转

1. `system-overview.md`
2. `foundations/facts-and-projections.md`
3. `foundations/lifecycle-overview.md`
4. `backend/conversation-projection.md`

## 如果问的是消息重复 / 消息丢失 / 端上历史不一致

1. `foundations/facts-and-projections.md`
2. `backend/conversation-projection.md`
3. `conversation/ledger.md`
4. `surfaces/web.md` 或 `surfaces/lark-adapter.md`
5. `operations/troubleshooting.md`

## 如果问的是运行生命周期 / 取消 / 恢复 / 卡住的运行

1. `backend/run-supervisor.md`
2. `runner/resident-runner.md`
3. `runner/runner-protocol.md`
4. `foundations/lifecycle-overview.md`

## 如果问的是数据归属（谁是事实来源）

1. `foundations/facts-and-projections.md`
2. `backend/data-model.md`
3. `conversation/ledger.md`
4. `backend/event-log.md`

## 如果问的是飞书

1. `flows/e2e-lark-message.md`
2. `surfaces/lark-adapter.md`
3. `backend/conversation-projection.md`
4. `conversation/conversation-and-members.md`

## 如果问的是 Web

1. `flows/e2e-web-message.md`
2. `surfaces/web.md`
3. `conversation/ledger.md`
4. `backend/conversation-projection.md`

## 如果问的是 Agent 执行内核 / 插件 / 记忆 / 技能 / 防早停

1. `runtime/framework.md`
2. `runtime/plugin.md`
3. `harness/harness.md`
4. `plugins/fs-memory.md`、`plugins/progressive-skill.md`、`plugins/task-guard.md`

## 如果问的是安全 / 隔离

1. `security/overview.md`
2. `runner/agent-file-system.md`
3. `conversation/conversation-and-members.md`

## 如果问的是 Issue / 看板 / 多 Agent 协作编排

> 以下页面 `status: design`，是已锁定但**尚未进代码**的设计，不要当成当前行为。

1. `foundations/issue.md`
2. `backend/orchestrator.md`
3. `flows/e2e-issue-lifecycle.md`
4. `conversation/conversation-and-members.md`（现状的 @提及自动触发，被 Orchestrator 取代）

## 如果问的是未来方向

读 `roadmap/future-work.md`，并顺其关联链接。**不要把 roadmap 条目当成当前行为。**

## 结构化清单

完整的概念图谱（id / 标题 / 状态 / 依赖 / 被依赖 / 路径 / 摘要）见同目录 `concepts.json`，可直接被程序消费。
