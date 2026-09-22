# Apps

`apps/` 是四个可运行的程序。有状态的核心是 `backend`：它持有产品事实（对话、账本、Agent Context、Project、Workflow）并创建每次执行。其余三个各自把一个界面接到它上面。

## 各应用一句话

- [`backend`](./backend/) — Elysia 服务，产品事实与执行控制面都在这里。每个 Agent Run 由它派单，spawn 一个一次性子进程；同时负责起停 lark-bot 实例。
- [`web`](./web/) — 浏览器界面：对话（`/chat`）、worktree 终端（`/coding`）、团队与资源管理、自动化与运维页。经 BFF 代理把请求转到 backend，浏览器不持有后端 token。
- [`oh-my-agent`](./oh-my-agent/) — oma，本仓库自研的 CLI 与 agent runtime。产品侧以 `--mode rpc` 当一个一次性子进程跑；独立使用时是交互式 TUI。
- [`lark-bot`](./lark-bot/) — 飞书桥接进程：入站把 IM 事件 POST 给 backend，出站订阅该对话的 SSE 并把终态消息渲染成纯文本发回飞书。每个 agent 一个进程。

## 怎么跑起来

日常开发直接 `bun run dev`（见 [开发环境](../docs/guides/development.md)）。分开跑也行：

```bash
# 后端（其他端多数依赖它）
ANTHROPIC_API_KEY=sk-... BACKEND_AUTH_TOKEN=dev bun run apps/backend/src/main.ts

# 浏览器界面
BACKEND_URL=http://localhost:3000 BACKEND_AUTH_TOKEN=dev bun run --cwd apps/web dev
```

各应用的参数、环境变量与内部数据流详见其子目录 README；系统层面的说明在 [项目 wiki](../docs/README.md)。
