# Architecture

详表在 `docs/architecture/`：执行链看 `backend/overview.md` 与 `runs/output-and-live-updates.md`，数据看 `backend/data-model.md`，Workflow 看 `workflow.md`，这里只给骨架。

## Backend 的六边形布局

多数功能域是同一个形状：`domain.ts`（纯类型）、`ports.ts`（存储边界）、`service.ts`（工厂函数返回业务实现）、`adapter-sqlite.ts`（实现）、`http.ts`（Elysia 路由）、`index.ts`（barrel）。个别缺路由文件（`agent-context`），或换了存储介质（`artifact` 用 `adapter-fs`，`mcp` 用 `adapter-file`）。

组装点在 `apps/backend/src/bootstrap/features.ts`：它建适配器、注入服务工厂、再挂路由。`apps/backend/src/main.ts` 只负责启动顺序与信号。

## Agent Run 的路径

- 对话服务把输入写进账本，然后创建 Run。
- `enqueueAndAcquire` 是唯一的 Run 创建入口，整段在一个事务里：入队、活跃 Run 守卫、分支 revision CAS、把游标之后最近 20 条可见消息追加成 Context 引用、解析这次生效的模型、写 `agent_run` 行。
- 派单按 `model_ref.backendKind` 查注册表（`oma` / `claude_code` / `pi` / `omp`），未知种类在预检阶段返回 422。
- 每个 Run spawn 一个一次性子进程；oma 走 stdin/stdout JSONL RPC，三个 CLI 后端各有自己的 argv 与输出格式。
- `BackendRunOutcome` 是唯一的终态依据；事件流只是观察用的 transient 数据。
- 终态提交在一个事务里写账本行、Context 引用、分支 CAS、Run CAS。

## Workspace bridge

`reconcileAgentResources` 写每个 Agent 工作区的配置：

- `.mcp.json`：启用的 MCP server、product-tools、知识召回 server
- `.oma/product-tools.json`：oma 侧的产品工具清单
- `<kind>/skills` 符号链接：分配到的技能包
- `knowledge/` 符号链接与 `index.md`：分配到的知识包
- `.claude/settings.json`：claude 后端预授权的产品工具

每次 spawn 之前会用数据库真相源重写 `.mcp.json` 与 product-tools 清单，桥接是单一作者。

## File-first 配置

`agent.yml` 是 Agent 配置的唯一来源（ADR 0020）。数据库里只有锚点行与一份物化缓存。`runtime_config` 里带 projects、权限模式、模型绑定等。

## 已删除的东西

多成员对话（1:1 收敛，ADR 0021）、产品侧的 Loop 与 CronJob（由 Workflow DSL 与触发调度取代，ADR 0025）、span / attempt / 持久会话与 checkpointer（Phase 6）。运行侧的 session 续接仍在，载体是分支上的 `cli_session_ref`（ADR 0019）。
