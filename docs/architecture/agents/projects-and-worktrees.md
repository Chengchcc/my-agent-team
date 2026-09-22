# Project 与 Worktree

Project 是仓库级协作实体，每个 (agent, project) 在 agent 工作区下物化一个 git worktree，Agent Run 就以它为工作目录跑。在此之上还有一条任务轴：同一个 project 下可以按用户命名的 slug 再开若干 worktree。

## 范围

覆盖：Project 实体与 CRUD 守卫、agent 与 project 的声明与 reconcile、两条 worktree 轴、路径与分支命名、mirror 生命周期、worktree 的桥接写入、Run 的 workspace 绑定、workspace lock、worktree 的读与合流操作。

不覆盖：Coding 页的终端面板（PTY、WS ticket，见 [Web 端](../surfaces/web.md)）、Agent Run 自身的生命周期（见 [Run 输出与实时更新](../runs/output-and-live-updates.md)）、mirror 的远端鉴权与 fetch 策略（未定，见 [ADR 0023](../../adr/0023-project-worktree-workspace.md)）。

## 实现文件

- `apps/backend/src/features/project/{domain,ports,service,adapter-sqlite,http}.ts` — Project 实体与 HTTP
- `apps/backend/src/features/project/worktree.ts` — git 管道：`ensureMirror` / `ensureWorktree` / `removeWorktree` / `createTaskWorktree` / `removeTaskWorktree` / slug 正则
- `apps/backend/src/features/project/worktree-ops.ts` — status / diff / fastForward / merge，全部跑在 bare mirror 上
- `apps/backend/src/features/project/workspace-lock.ts` — 按 root 的 promise 链互斥
- `apps/backend/src/features/coding/task-worktrees.ts` — 任务 worktree 列表（fs 扫描）与路径白名单
- `apps/backend/src/features/agent/workspace-bridge.ts` — 往 agent 工作区与各 worktree 写 `.mcp.json` / `.oma/product-tools.json`
- `apps/backend/src/bootstrap/features.ts` — reconcile、`resolveWorkspace`、worktree ops、任务 worktree 的创建与删除接线

## Project 实体

```text
ProjectRow = { projectId, name, repoUrl: string | null, defaultBranch: string | null, createdAt, updatedAt }
```

`repoUrl` 与 `defaultBranch` 都可以为空——纯本地项目也是合法的。

`createProject` 要求名称非空、去空格，重名冲突翻译成 400。写入前过 `validateRepoRefs`：`repoUrl` 必须是 `https` / `ssh` / `file://` 或绝对或相对本地路径，且不能以 `-` 开头；`defaultBranch` 不能以 `-` 开头，不能含空白、路径分隔符或 `..`。这两条挡的是 git 选项注入与 ref 遍历。

删除有两道守卫，任一命中返回 409：仍被某个 agent attach（错误里列出 agentId），或被某个 conversation 绑定。

HTTP：`GET/POST /api/projects`、`GET/PATCH /api/projects/:id`、`DELETE /api/projects/:id`。

## agent 与 project 的绑定

绑定不落库，声明在 agent 自己的 `agent.yml` 里：`runtime_config.projects: string[]`。没有关联表，工作区文件是唯一真相源，数据库里的 `agents.config` 只是物化缓存。

改动经 `POST/PATCH /api/agents` 进来，service 会把改动前的 project 列表一并交给 `onAgentUpdate`，由 compose 层调用 reconcile。

reconcile 做两件事：

- **detach 清理**：旧的但不在新列表里的 project，`ensureMirror` 后 `removeWorktree`（`worktree remove --force` 加 `branch -D agent/<agentId>/<projectId>`）；失败只告警。
- **attach 物化**：每个 project 做 `ensureMirror` 与 `ensureWorktree`，成功的路径进 `extraRoots`；失败、或者 worktree 槽位被普通目录占用，只告警不抛错。

然后 `reconcileAgentResources` 对主工作区和每个 worktree 写 `.mcp.json` 与 `.oma/product-tools.json`；技能与知识库的链接只挂主工作区。

## 路径与命名

| 东西 | 位置 |
|---|---|
| mirror | `<dataDir>/projects/<projectId>.git` |
| agent 工作区 | `<dataDir>/agents/<slug>` |
| agent 轴 worktree | `<agentWorkspace>/projects/<projectId>`，分支 `agent/<agentId>/<projectId>` |
| 任务轴 worktree | `<agentWorkspace>/projects/<projectId>.<slug>`，分支 `agent/<agentId>/<projectId>.<slug>` |

**agent 轴**每个 (agent, project) 恰好一个 worktree，基线是 `defaultBranch ?? "HEAD"`。物化时如果目标目录已经被普通目录占用，直接返回 null——**不覆盖用户文件**；如果分支还在但目录没了，就直接 checkout 复用。

**任务轴**由用户显式创建、用户命名 slug，冲突即拒绝：不自动生成、不按需物化，这一点与主 worktree 的 reconcile 语义刻意区分开。slug 正则两处同源、都要求小写：`^[a-z0-9][a-z0-9-]{0,39}$`。slug 非法抛 ValidationError，目录或分支已存在抛 ConflictError，基线是 `defaultBranch`。

任务 worktree 的列表是 **fs 扫描**出来的：对每个 agent 的 `projects/` 目录做 `<projectId>.` 前缀匹配，只认目录，slug 不过正则的跳过。

端点：`GET /api/coding/worktrees?projectId=`、`POST /api/coding/worktrees`（body 有 projectId / agentId / slug）、`POST /api/coding/worktrees/remove`（body 带 force）。

mirror 的物化是 `git clone --mirror` 到 `<path>.tmp` 再 rename，避免并发建出半个 mirror。已存在时**只 ff-fetch 项目的 base 分支**——mirror 默认的 `+refs/*:refs/*` refspec 会把本地 agent 分支删掉或回退。`repoUrl` 变了就先 `remote set-url`。

## 终端只能开在命名空间内

终端 spawn 的 `worktreePath` 必须过 `validateWorktreePath`：只接受「该 agent 的主 worktree」或「主 worktree 加合法 slug」两种形态，其余抛 ValidationError。终端是代码执行面，这里不能接受任意 cwd。

Coding 页的解析里，**任务 worktree 不会被按需物化**（不存在即 404），只有主 worktree 会在打开时现场 `ensureMirror` / `ensureWorktree`。agent 没 attach 这个 project 返回 409，project 没有 repoUrl 返回 404。

## 删除与守卫

任务 worktree 的删除由服务端把两道关：路径上还有 running 终端 → 409（提示先关终端）；没带 force 时，若有未提交改动或分支上有基线之外的提交 → 409（`branch -D` 会把它们丢掉）。删除成功后，同路径上的 exited 终端会被关掉，免得指着一个已经不存在的目录。

主 worktree 没有删除入口，它只随 agent 与 project 的 detach 生命周期走。

## 桥接写入

创建任务 worktree 成功后立即 `bridgeWorktreeRoot`：只写 `.mcp.json` 与 product-tools 清单，**刻意不碰技能和知识库**——那里用空集合去写会抹掉主工作区挂上去的链接。

Run 每次 spawn 之前都会 `rewriteWorkspaceBridge` 从数据库真相源重写一遍 `.mcp.json` 与 product-tools 清单。桥接是单一作者，被篡改的文件必然在下次 spawn 前被覆盖（见 [安全模型](../security/overview.md)）。

## Run 的 workspace 绑定

`resolveWorkspace` 是 agent-run execution 的注入依赖，实现在组装点：

- 对话没绑 project（或 project 为空）→ agent 工作区；
- 对话绑了 project 且 agent 已 attach → `<agentWorkspace>/projects/<projectId>`；
- 对话绑了 project 但 agent 没 attach → **直接报错**，错误信息指向 agent 的 `runtime_config.projects`，不静默回退。

访问级别由 agent 的 `permission_mode` 决定：`ask` 给只读，其余给读写。Run 自己 pin 了 `run.workspace` 时优先于 `resolveWorkspace`。

**context 与 cwd 是两件事**：技能、prompt、token、身份永远来自 agent 工作区，只有 cwd 是 worktree，加上那两个桥接文件。

对话的 `conversation.projectId` 可空；创建时若指向不存在的 project 返回 400。

## workspace lock

按 root 的 promise 链互斥，key 先用 `realpath` 归一。唯一调用点是 Agent Run dispatch 的投递段——同一个 worktree 上的 Run 由此串行。

`isLocked()` 在仓库里没有调用方。

## worktree 的读与合流

`WorktreeOps` 有四个动作：status（用 `git rev-list --left-right --count` 算 ahead/behind，顺带报 worktree 目录是否已就位）、diff（`git diff base...agent/<a>/<p>`）、fastForward、merge。

fastForward 的前置条件是 merge-base 必须等于 base 的 tip，否则 409 diverged；merge 的前置条件是用 `git merge-tree --write-tree` 试跑一遍，无冲突且未 diverged 才动。两者共用同一段移动 base 的逻辑：先移 base，可选 push（mirror 需要临时把 `remote.origin.mirror` 关掉），**push 失败把 base 滚回原来的 tip**。

所有 git 命令都在 bare mirror 上跑，从不在活的 worktree 里跑。

HTTP：`GET /api/projects/:id/worktrees`、`GET .../worktrees/:agentId/diff`、`POST .../fast-forward`、`POST .../merge`。没接 ops 返回 501，project 没有 repoUrl 返回 409。

## 不变量

1. Project 是仓库级实体，worktree 是它的物化产物。agent 轴每个 (agent, project) 恰一个；任务轴可以是任意多个显式命名的 slug。
2. 绑了 project 的对话，其 Run 以 worktree 为 cwd；agent 没 attach 就是 dispatch 失败，不静默回退。
3. 同一个 worktree root 上的 Run 经 workspace lock 串行，只有这一条路径用锁。
4. 技能与 prompt 只来自 agent 工作区，worktree 里被桥接的只有 `.mcp.json` 与 product-tools 清单。
5. 终端 cwd 只接受该 agent 命名空间内的路径。
6. 删除 worktree 不悄悄丢工作：任务轴需要显式 force，主 worktree 只随 detach 走。

## 已知缺口

- mirror 的远端同步只做了 base 分支的 ff-fetch 和 `remote set-url`，没有鉴权与凭证管理，实际只支持公网或本地可达的仓库。
- 合流操作只认精确分支 `agent/<agentId>/<projectId>`，任务轴的 `.<slug>` 不在范围内——`worktree-ops` 没有 slug 参数。
- `docs/adr/0023-project-worktree-workspace.md` 的状态仍写着 Proposed，而 P1、P2 与附录都已实现；ADR 里「detach 也在锁内」的说法与代码不符（detach 直接跑 git）。

详细清单见 [`../roadmap.md`](../../roadmap.md)。
