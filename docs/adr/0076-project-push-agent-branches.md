# ADR 0076: 工人的改动回写仓库 —— 只推 `agent/*` 分支

- 状态: Proposed
- 日期: 2026-11-22
- 相关: ADR 0023（project worktree）、0072（前台不干活）、0074（超级助理模型）、0075（请求路由）

## 背景（真机 2026-11-22）

前台被要求"改 README"时，产出的是**给用户粘贴的文本**，不是一次真实的仓库改动。查证：

- 真仓库 `README.md` 未被触碰；
- 工人工作区里的 clone（`agents/worker-one/projects/<projectId>`）**git status 干净**；
- 该轮**没有任何子房**（没有派发）。

原因不是模型懒，而是**链路断层**：

```
worker 改的是自己的 clone  →  ???  →  GitHub
真仓库 /root/my-agent-team ←  ???  →  GitHub
```

没有回写通道时，"派出去"的收益只有"一份改在我副本里的东西"，而"我自己写一段文本"立刻可见——理性的模型会选择后者。**所以在打通回写之前，靠提示词压它派活是在和激励作对。**

## 决策

### D1 推送由后端执行，凭据永不进子进程

新增产品工具 **`project_push`**：

```jsonc
{
  "project": "<projectId 或 name>",   // 必须是该 agent 已挂载的项目
  "message": "…",                      // commit subject
  "note": "…"                          // 可选，进 commit body
}
```

- 工具**不接收分支名**：分支由后端从 `runId` 派生（`agent/<runId>`），模型无法让它推 master；
- 凭据（`PROJECT_PUSH_TOKEN`，或每项目一条 deploy key）只存在于后端进程；
- 子进程只看到工具调用与结果，**shell 里没有 token**——这一点与 ADR 0072 的"写权限=能力"同一原则。

### D2 分支策略：只推 `agent/*`，永不 force

| 规则 | 理由 |
|---|---|
| 分支名 = `agent/<runId>` | 可追溯：一个 run 一条分支；重跑 = 新分支 |
| 目标分支若已存在且内容不同 ⇒ 拒绝并加后缀 | 不做 force-push——覆盖别人的分支是数据丢失 |
| 永不推 `master`/`main` | 主分支只经 PR 合入，人 review |
| 只推该 agent 已挂载项目的 remote | 没有挂载 = 没有 clone = 拒绝 |

### D3 返回值决定"派活是否更划算"

```jsonc
{ "branch": "agent/01J…", "commits": 2,
  "compareUrl": "https://github.com/owner/repo/compare/master...agent/01J…",
  "pushed": true }
```

**这就是关键激励**：派出去能拿到一个可点的 PR 链接；自己写只能拿到一段文本。前台把这三行转述给人，链路就闭合了。

### D4 审计与归属

- 每个 commit 的 author 记工人（`<agentId>@local`），committer 记后端；
- 推送记录落 `product_tool_call`（已有表）+ ops 事件 `project_pushed`；
- 需求（requirement）详情页可显示"本需求产生了一个分支"（等真实使用再加）。

### D5 沙箱的另一半（同批要收）

今天查到的另一个事实：**bash 没有被限制在工作区内**（工人能 `cd /root/my-agent-team` 并成功执行）。所以：

- 在 `deny_write_paths` 里显式加入真仓库根与 `.backend-data`（至少挡住文件工具）；
- bash 的路径级只读需要沙箱支持（bwrap 只读 bind 或 cwd 锁），列为独立的收口项——它与本 ADR 的 push 通道互补：**该改的走 push，不该碰的物理上碰不到**。

## 前置：交付物必须是 artifact（H1，已落地）

回写之前，"派单"必须先能**产出可交接的东西**。2026-11-22 的 chain 探针给出了缺口：研究员把报告写成了聊天文本，`artifacts/` 下没有新增，于是"交接"没有可交接的物。

- 派单 brief 新增 `<delivery>`：非 answer 的交付必须 `artifact_upload`（folder 用需求 id 或任务名），最终回答附 `artifacts://` 路径；
- 工人终态帧新增 `<artifacts>`：后端从 `product_tool_call` 里读该 run 的上传记录，把 URL 原样回传，并注明"下一步要的是 URL，不是复述"。

## 计划要随唤醒一起回来（H2，已落地）

计划若只活在提示词里，工人回来时唤醒的是一次**全新调用**，计划已经不在了——chain 停在这一步。

- 纪律：多步任务先 `todo_write`（每步一个 item，标明谁做），再派第一步；
- 结构：工人终态唤醒派单者时附 `<plan>`（派单者最近一次 run 的 `todo_snapshot`），并写明"计划还有未完成项 ⇒ 带着 artifacts 直接派下一步，不要回来问人"。

## 不做什么

- 不做自动合并、不自动开 PR（v2：拿 compare URL 人点一下即可）；
- 不给每个工人一把独立 PAT（多一把凭据就多一处泄漏面）——后端一把、按项目白名单使用；
- 不在提示词里继续加"要派活"的句子：本 ADR 的前提是**让派活的收益高于自己写**，而不是让禁止更响。
