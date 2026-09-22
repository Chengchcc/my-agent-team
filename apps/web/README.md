# web

Next.js 控制台，后端面向人的入口：把后端的 HTTP/SSE API 包装成可视化工作台。浏览器从不直连后端，所有请求都经由应用自身的 BFF 代理转发，它另承担一层 cookie 会话登录。

## 页面

根路径 `/` 重定向到 `/today`。对话页在 `/chat/[conversationId]`：账本消息按 turn 分组渲染，run 事件流作为临时气泡叠在上面，两者靠 messageId 对账。`/team` 是 agent 总览与配置（模型、权限、身份、MCP、项目、技能与知识库），`/workflows` 是 workflow 及其执行记录，`/system` 收运行诊断与设置，`/artifacts` 是产物列表与预览。`/coding` 是 project 与 worktree 的终端宿主，持有 backend 进程里的裸 PTY，与对话页没有共享状态。

渲染层的关键组件都在 `src/components/`：`ConversationCanvas`、`Timeline`、`MessageBubble`、`Composer`、`ReasoningTrace`、`TodoPanel`，输入队列与审批卡片分别是独立文件 `ComposerInputQueue.tsx`、`TimelineApprovalCard.tsx`。

## 两条 SSE

对话流（`/api/bff/conversations/:id/events`）是 canonical 输入：每次挂载全量重放，重连走 `Last-Event-ID`，靠水位线加滑窗去重。每个 Run 另有一条流（`/api/bff/agent-runs/:runId/events`），只产生临时气泡——canonical 行到达即被丢弃，失败运行的气泡留到刷新。两条都由 `src/hooks/useConversation.ts` 消费。

## 取数边界

组件不写 `queryFn`：查询键与 query option 只在 `features/<name>/` 下，`app/` 与 `components/` 里出现内联 queryFn 会被 `audit:contracts` 拦下。需要服务端直读后端时用 Server Component + `createServerClient`，mutation 一律在 client 组件里触发。

## 相关文档

- [Web 端](../../docs/architecture/surfaces/web.md)
- [端总览](../../docs/architecture/surfaces/overview.md)
- [Web 消息端到端](../../docs/architecture/flows/e2e-web-message.md)
- [AGENTS.md](./AGENTS.md) — 本 app 的命令、目录结构与编码约定
