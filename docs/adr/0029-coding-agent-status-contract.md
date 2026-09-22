# ADR 0029: agent-status 文件契约接受双写重复

## 状态

Accepted (2026-09-22)

## 上下文

Coding 页的结构化状态（P2）：oma TUI（writer，`apps/oh-my-agent/src/modes/tui/agent-status.ts`）向 `<worktree>/.oma/agent-status.json` 写 `{state, sessionId, ts}`；backend（reader，`apps/backend/src/features/coding/agent-status.ts`）轮询读取并聚合进 `/api/coding/terminals` 的 `agentState`。`e2e-contract-rules.md` §1 要求跨进程结构两端共享 schema。

## 决策

**接受两份手写副本，不建共享包。** 契约只有 3 个字段 + 一条 staleness 规则（writer 60s 心跳、reader 3min 上限，两侧常量需同步改）；为一个 ~20 行的读取器建 leaf package 的成本高于漂移风险本身。有意分歧：writer 写 `sessionId`（调试用），reader 忽略。

## 后果

- **漂移义务**：任何字段/常量变更必须双侧同 commit 修改；两侧各有单测钉住解析形状（`agent-status.test.ts` 两份）。
- 若契约长到第二个消费者或第 4 个字段，升级为 `packages/` 内共享 zod schema（届时回填本 ADR）。
- 同类先例：oma wire protocol（ADR 0024 的 fixture 契约）同样接受受控重复。
