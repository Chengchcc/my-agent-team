# web

Next.js 控制台，后端面向人的入口：把后端的 HTTP/SSE API 包装成可视化工作台。浏览器从不直连后端，所有请求都经由应用自身的 BFF 代理转发，它另承担一层 cookie 会话登录。

## 页面

根路径 `/` 重定向到 `/today`。对话页在 `/chat/[conversationId]`：账本消息按 turn 分组渲染，run 事件流作为临时气泡叠在上面，两者靠 messageId 对账。`/team` 是 agent 总览与配置（模型、权限、身份、MCP、项目、技能与知识库），`/workflows` 是 workflow 及其执行记录，`/system` 收运行诊断与设置，`/artifacts` 是产物列表与预览。`/coding` 是 project 与 worktree 的终端宿主，持有 backend 进程里的裸 PTY，与对话页没有共享状态。

渲染层的关键组件都在 `src/components/`：`ConversationCanvas`、`Timeline`、`MessageBubble`、`Composer`、`ReasoningTrace`、`TodoPanel`，输入队列与审批卡片分别是独立文件 `ComposerInputQueue.tsx`、`TimelineApprovalCard.tsx`。

## 实时状态的两条来源

对话状态来自 AHP：`src/lib/ahp.ts` 经 BFF 取票连上 `/ws/ahp`，快照给历史、动作流给增量，上游 reducer 折出状态，`src/lib/chat-state.ts` 映射成列表与在飞轮次。run 流（`/api/bff/agent-runs/:runId/events`）只剩流规则提示与 workflow 进度，两者都由 `src/hooks/useConversation.ts` 消费。

## 取数边界

组件不写 `queryFn`：查询键与 query option 只在 `features/<name>/` 下，`app/` 与 `components/` 里出现内联 queryFn 会被 `audit:contracts` 拦下。需要服务端直读后端时用 Server Component + `createServerClient`，mutation 一律在 client 组件里触发。

## 相关文档

- [Web 端](../../docs/architecture/surfaces/web.md)
- [端总览](../../docs/architecture/surfaces/overview.md)
- [Web 消息端到端](../../docs/architecture/flows/e2e-web-message.md)
- [AGENTS.md](./AGENTS.md) — 本 app 的命令、目录结构与编码约定
