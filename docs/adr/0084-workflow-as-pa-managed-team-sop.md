# ADR 0084: Workflow 作为 PA 自主管理的可复用团队 SOP

- **状态**：Implemented（2026-11-28 全 4 期落地并验证）
- **相关**：[设计哲学](../architecture/design-philosophy.md)、[Workflow 引擎](../architecture/workflow.md)、[团队协作](../architecture/team-coordination.md)、[ADR 0042](./0042-workflow-rework-as-new-attempts.md)、[ADR 0075](./0075-request-routing.md)、[ADR 0077](./0077-requirement-owns-the-workspace.md)、[ADR 0081](./0081-web-cutover-to-oma-design.md)、[ADR 0082](./0082-cross-surface-linkage-human-labels-and-channels.md)

## 背景与问题

CrewDesk 已经拥有成熟的声明式工作流引擎（`packages/workflow` + `apps/backend/src/features/workflow`），但它在当前架构中与 Agent Team 存在 6 处结构脱节：

1. **PA 对 Workflow 无运行期工具**：`workflow` MCP 仅暴露只读 `workflow_read` 与仅提议 `workflow_write`；`product-tools` 的 32 个工具里没有任何工作流列举、启动、查询或取消工具，PA 无法在对话中复用或管理 SOP。
2. **多节点代码流水线的 Requirement / Worktree 断链**：`runAgentNode` 为每个节点创建 `workflow:<executionId>:<nodeId>` 会话并写入 `projectId`，但从未挂载 `execution.requirementId`，导致 ADR 0077 的 `workspaceForRun` 为每个带 `repo` 的节点新建孤儿 Requirement 和独立 git worktree（`coder` 与 `reviewer` 不在同一份代码树工作），且 `Requirement` 读模型不感知关联的 `workflow_execution`。
3. **硬编码 `permissionMode: "yolo"`**：因为节点会话不在会话列表里展示、无人回答审批，`runAgentNode` 强行使用 `yolo`，绕过了 ADR 0075/0080 的权限与不可逆风险护栏。
4. **双轨 HITL 与无归属通知**：`workflow_pending_human`（含 `#budget` 门）独立于 `/api/attention`，非 `/run` 触发的流程停在人工门后形同黑洞；执行终结与 Cron 3 次失败熔断无房间回流，飞书端依赖重启即断的客户端轮询 `pollWorkflowProgress`。
5. **缺少版本留痕与沙箱验证面**：`<dataDir>/workflows/*.workflow.json` 是无历史记录的裸文件目录，缺乏回滚手段；前端 `dry-run` 仅做静态 mock 路由，无法在审批 `script` 节点前真实试跑验证脚本。
6. **全局单实例硬锁与硬编码 `agentId`**：`idx_workflow_execution_single_flight` 按 `workflow_id` 全局互斥，同一 SOP 无法并发服务多个 Requirement；`agent` 节点无法复用团队能力池（`recallWorkers`）。

## 核心定位

遵守 [设计哲学](../architecture/design-philosophy.md)（不发明平行概念）：

> **Workflow 不是平行于 Agent Team 之外的第二套编排系统，而是 Team 的「PA 自主管理、可复用、确定性的标准作业程序（SOP）」。**

- **PA + `dispatch`**：处理非确定性协作（需求澄清、临时拆解、探索性调查）。
- **Workflow**：承载沉淀下来的确定性 SOP（多步接力、结构化条件路由、返工预算、人工审批门、定时/Webhook 触发），复用 Team 现有的 `Requirement`、`Workspace`、`Attention`、`Proposal` 和 `Product Tools` 主轴。

## 架构决策

### D1. `<dataDir>/workflows` 启用本地 Git 自动留痕（复用 Wiki 模式）
- 新增 `createFsWorkflowStore(workflowDir)`：自动 `git init`（git 不可用时降级继续工作并告警），所有写入走 `tmp + rename` 原子替换并提交 git commit，作者归属明确记录为 `user`、`agent:<id>` 或 `user (adopted proposal)`。
- 暴露只读版本历史与一键回滚接口：`GET /api/workflow-definitions/:workflowId/history` 与 `POST /api/workflow-definitions/:workflowId/revert`。

### D2. PA 自主创建与管理 Workflow 的分级授权边界（修订 ADR 0081）
修订 ADR 0081 中「`workflow_definition` 一律禁止直接落盘」的约束，按真实风险分层：
- **纯声明式 SOP 变更**（仅含 `start / agent / human / end`，未新增或修改 `script` 节点代码，且未新增/修改/启用 `cron` 触发器）：PA 调用 `workflow_save` 通过 `parseWorkflow()` 与 `agentId`/`repo` 校验后，**直接原子落盘 + git commit + 立即 `resyncTriggers()`**。因为 D5 已去掉节点硬编码 `yolo`，纯声明式 SOP 相对普通 `dispatch` 是零提权的。
- **高风险变更（含新增/修改 `script` 节点代码，或新增/修改/启用 `cron` 定时触发器）**：PA 仍可完整编写，但 `workflow_save` 自动生成一条持久化 `proposal`（`kind: "workflow_definition"`，附带 `requiresApprovalFor: ("script" | "cron")[]`、`scriptNodes`、`cronTriggers` 与 `proposedBy`），等待人在前端验证并显式授权。
- **采纳即落地**：`proposal/apply.ts` 补齐 `workflow_definition` 的服务端执行路径——人点击 Adopt 后，校验 `parseWorkflow()`、原子写入 `*.workflow.json`、git commit 并 `resyncTriggers()`（兼容编辑器内已保存同内容的场景）。

### D3. 前端验证与 `script` 节点沙箱试跑
- 新增后端验证接口：
  - `POST /api/workflow-definitions/validate`：对任意草案 JSON（包括未保存或待审批的 `proposal`）运行 `parseWorkflow()` + 语义检查（引用的 `agentId` 是否存在、带 `repo` 的节点是否绑定到对应项目、是否包含 `script`/`cron` 授权项）。
  - `POST /api/workflow-definitions/test-script`：在 `@chengchenccc/sandbox`（无网络、禁用敏感目录读取、严格超时上限）中试跑一段 `script` 节点代码与样例 JSON 输入，返回 `{ ok, exitCode, output, stdout, stderr, durationMs }`（受 `WORKFLOW_SCRIPTS_ENABLED` 控制）。
- 前端在三处提供验证能力：Workflow 节点属性面板（`NodePropertyPanel` 中对 `script` 节点一键试跑验证）、Workflow 编辑器工具栏（整图校验与版本历史查看/回滚）、以及待决策收件箱（`ProposalsView` 展示 `script`/`cron` 风险标记、允许先验证/试跑脚本再一键采纳）。

### D4. 统一 `product-tools` Workflow 工具链
在 `product-tools`（MCP-over-ACP + per-run token 鉴权 + `product_tool_call` 幂等账本）新增 7 个工具：
- 读/查（所有 Agent 可用）：`workflow_list`、`workflow_read`、`workflow_status`
- 管（仅 Front Desk PA 可用，Worker 调用拒绝）：`workflow_save`、`workflow_delete`（运行中拒绝删除，删除前留 git commit）
- 跑/控（仅 Front Desk PA 可用）：`workflow_run`（自动继承调用房间的 `conversationId`、`requirementId`、`projectId`）、`workflow_cancel`

保留现有 `workflow` MCP Server（`workflow_read` / `workflow_write`）并共享同一套 store/authorization 逻辑以保证编辑器侧向后兼容。

### D5. 整条 Workflow 共享单一 Requirement 与 Worktree，且去掉硬编码 `yolo`
- **共享 Requirement / Worktree**：`startExecution` / `runToCompletion` 当 `execution.projectId` 非空或定义中存在 `node.repo` 且 `execution.requirementId === null` 时，自动创建 1 条关联该 `projectId` 与 `originConversationId` 的 `Requirement` 并回写 `workflow_execution.requirement_id`；所有 `agent` 节点会话（`workflow:<executionId>:<nodeId>`）在创建时自动挂载该 `requirementId`（通过 `workspaceSvc.attachConversation`），触发的 `agent_run` 同样写入 `requirement_id`。由此同一执行中的所有代码节点（如 `coder → reviewer`）共享同一份 git worktree，不再污染 `/requirements`。
- **Requirement 读模型闭环**：`RequirementView` 纳入关联的 `workflow_execution` 摘要，处于 `running` / `waiting_human` 的工作流正确反映到 Requirement 状态。
- **取消硬编码 `yolo`**：`runAgentNode` 不再强制传 `permissionMode: "yolo"`，改为继承目标 Agent 自身配置的 `permission_mode`；节点触发的审批与提问走 D6 统一收件箱和 ADR 0075 路由。

### D6. 收件箱（`/api/attention`）与房间回流合一
- `GET /api/attention` 新增 `workflowHumanTasks`（或在 `awaitingYou` 中以统一结构返回待处理的 `workflow_pending_human`，含 `#budget` 返工门，标明 `source: "workflow"`、`executionId`、`workflowId`、`nodeId`、`question`、`form`），Web 收件箱与飞书共用单一真相源。
- `WorkflowExecutionService` 增加生命周期回调 `onExecutionEvent`（终结 `success`/`failure`/`cancelled`、进入 `waiting_human`）以及 `trigger-scheduler` 增加 `onCircuitOpen`（连续 3 次失败熔断）：有 `conversationId` 时直接向发起房间回流摘要消息（含最终输出/产物链接或审批引导）；Cron/Webhook 无房间时投递到默认 PA 会话，确保人和 PA 不再漏掉异步结果与熔断告警。

### D7. 能力池路由与并发策略
- **能力池路由**：`packages/workflow` 的 `agent` 节点新增可选 `capability?: string`（允许仅声明 `capability` 而省略 `agentId`）；运行时通过 `recallWorkers` 从启用且绑定对应 `repo` 的 Worker 池中择优分派，并记录实际分派的 `agentId` 到节点事件。
- **并发策略**：`WorkflowDefinition` 新增可选 `concurrencyPolicy?: "forbid" | "per_requirement" | "allow"`（默认：含 `cron` 触发器为 `"forbid"`，其余为 `"per_requirement"`）。新增迁移 `0075_workflow_concurrency_policy.sql` 移除硬编码全局 `idx_workflow_execution_single_flight` 唯一索引，改由 SQLite `.immediate()` 事务内的策略检查保证原子互斥。

## 验收标准

1. **Git 留痕**：`workflow_save` / `PUT` / `DELETE` / `proposal adopt` 均在 `<dataDir>/workflows` 产生带作者的 git commit；`/history` 与 `/revert` 单测通过。
2. **分级授权**：PA 保存纯声明式 workflow 直接落盘并立即可跑；保存含新增/修改 `script` 或 `cron` 的 workflow 返回 `pending_approval` + `proposalId`，人在前端验证并 Adopt 后自动落盘并同步 cron。
3. **共享工作区**：2 节点 `coder → reviewer` 代码 workflow 在同一 `requirementId` 下只创建 1 个 Requirement 和 1 份 worktree；`RequirementView` 显示关联工作流执行。
4. **统一 Attention 与回流**：workflow 停在 `human` 节点时 `GET /api/attention` 可见；终结或 Cron 熔断时发起房间/默认 PA 收到回流通知。
5. **能力池与并发**：带 `capability` 的 `agent` 节点能动态路由 Worker；`per_requirement` / `allow` 策略下不同 Requirement 可并发执行同一 workflow，同 Requirement 仍受原子防重保护。
6. **全仓门禁**：`packages/workflow`、`apps/backend`、`apps/web`、`apps/lark-bot` 全量 `typecheck` / `lint` / `test` / `audit` / `audit:coverage` 与 CI 全绿。
