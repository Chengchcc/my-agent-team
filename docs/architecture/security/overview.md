# 隔离与安全模型

系统的安全由几条彼此正交的边界叠加而成，没有一道总闸：入口鉴权、文件工具的路径 jail、命令执行的 OS 沙箱、插件与 MCP 的信任门。每条各挡一类，也各不管另一类。

## 范围

覆盖：后端入口鉴权（含 WebSocket 这个例外）、Run 的工作区绑定、文件工具的路径 jail、bash 的两层约束、四条边界各自管什么不管什么。

不覆盖：oma 内核内部的防线（见 [oma 内核防线](./oma-kernel.md)）、bash 沙箱的实现细节（见 [bash 沙箱](./bash-sandbox.md)）、还没修的问题（见 [安全与债务清单](./debt.md)）。

## 实现文件

- `apps/backend/src/app.ts` — 鉴权钩子装配，豁免 `/health` 与 `/ws/*`
- `apps/backend/src/infra/auth.ts` — token 常量时间比较
- `apps/backend/src/features/agent-run/execution-dispatch.ts` — 每次 Run 的工作区解析与桥接重写
- `apps/oh-my-agent/src/core/tools/workspace-sandbox.ts` — 文件工具的路径 jail
- `apps/oh-my-agent/src/core/tools/bash.ts` — bash 的 cwd 校验与凭据剥离
- `apps/oh-my-agent/src/core/tools/bash-sandbox.ts` — bash 的 OS 沙箱

## 入口鉴权

钩子挂在 Elysia 的**主实例**上，而且注册在所有 feature 插件的 `.use()` 之前。这一条是踩过坑写下的：插件的 `onBeforeHandle` 不作用于父实例路由，曾经导致整个 API 裸奔，所以 `app.test.ts` 里有专门的门禁测试钉住 401 与 200 两条路径。

精确豁免只有两处：

- `/health`；
- `/ws/*` —— 浏览器不能给 WebSocket 设请求头，所以这里改用一次性 ticket：浏览器先经认证过的 BFF 换一张 256 位、60 秒有效、只用一次的票，再带票直连。豁免不等于裸奔，票在 WebSocket 路由内部校验。

token 比较是常量时间的（长度不等直接拒，否则 `timingSafeEqual`）。后端 token 只在服务端流转：Web 的 BFF 注入它，浏览器不持有。

另外，进程启动时如果监听的不是回环地址、而 token 还是字面量 `dev-token`，会打一条告警——只是告警，不拒绝启动。

## 对话层

对话是 1:1 的：participant 就是 `conversation.agent_id`，成员表已经删掉。

账本上的 `addressedTo` 参与的是**触发路由**，不是可见性：判断这个 Agent 该不该被这条消息唤起时看它，渲染时不看。消息本身带 `visibility` 标记（`conversation` 或 `internal`），`internal` 的不进 Agent Context，也不出现在产品工具读到的历史里。

## 执行层的工作区

每次 Run 的工作区在取 Run 时就冻结成 `{root, access}`，`access` 由 Agent 的权限模式决定：`ask` 给只读，其余给读写。绑定了 Project 的对话走该 Project 的 worktree（见 [Project 与 Worktree](../agents/projects-and-worktrees.md)）。

spawn 之前，工作区里被桥接的文件（`.mcp.json`、product-tools 清单）会从数据库真相源重写一遍。桥接是单一作者，被改过的文件必然在下次 spawn 前被覆盖。

## 文件工具的路径 jail

`workspace-sandbox` 提供三个校验：已经在的文件要 realpath 落在 root 内（挡 symlink 逃逸），新建的文件要向上找最近已存在的父目录查 realpath（挡中间目录是 symlink），cwd 的 realpath 必须在 root 内。

它管的是 read / write / edit / glob / grep / ls / tree 这些工具。

## bash 的两层约束

第一层是 cwd 校验：cwd 的 realpath 必须在工作区内，越界是工具错误。这一层**不约束命令语义**——`cat /etc/passwd` 照样能跑。

第二层是 opt-in 的 OS 沙箱（Linux 的 bwrap、macOS 的 sandbox-exec），默认不开，不支持的平台或工具缺失会直接报错而不是静默降级。它强制的是写集合与网络，读是开放的。细节见 [bash 沙箱](./bash-sandbox.md)。

另外两条静态边界始终生效：bash 子进程的环境变量会剥掉凭据形状的变量（`*_API_KEY`、`*_AUTH_TOKEN`、`*_TOKEN`、`*_SECRET`、`PASSWORD` 这类），输出有 10 MiB 上限。

## 四条边界各管什么

| 边界 | 挡住 | 不管 |
|---|---|---|
| 入口鉴权 | 未带 token 的请求 | 资源归属：没有 tenant 或 principal 列，带 token 就能读全部数据（单用户模型的既定取舍，见 [ADR 0026](../../adr/0026-agent-threat-model.md)） |
| 账本可见性 | `internal` 消息进入 Context 与产品工具 | 文件访问范围 |
| 文件 jail | 文件工具读写工作区之外 | 命令执行：bash 不受它约束 |
| bash 沙箱 | 命令的写入范围与网络（开启时） | 读；也不管读 `/proc` 之类绕过环境的路径 |

还有一层在 oma 进程自身：它拿到的环境变量是白名单转发过来的，后端的 token 与宿主机密钥不会到达它（见 [oma 内核防线](./oma-kernel.md)）。

## 不变量

1. 鉴权挂在主实例上，豁免只有 `/health` 与 `/ws/*`，后者靠一次性 ticket 补偿。
2. 浏览器不持有后端 token，Web 侧由 BFF 在服务端注入。
3. Run 的工作区在取 Run 时冻结，spawn 前桥接文件必被重写。
4. 文件工具一律过 realpath jail；bash 的 cwd 也过同一套校验。
5. bash 命令语义不受 cwd 校验约束，要约束得开 OS 沙箱。
6. 子进程环境变量按白名单转发，凭据不进子进程。
