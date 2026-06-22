# M19 Spec — 编排单一权威 · Issue 富化 · Coding Thread · 看板工作台

> **Status:** Spec（合并稿）→ Self-reviewed → **拍版已定**（七问决策落在 §14；本稿已据 2026-06-22 二次决策回填）。
> **本稿合并了原 M19（@提及收编进编排）+ 原 M20（Issue 富化 / Coding Thread / 看板工作台）为单一里程碑** —— 应用户 2026-06-22 决策「M19 没有实现，直接两个合并在一起」。原因正当：原 M20 的 §7「把 issue run 接回 conversation projection」**强依赖** 原 M19 的 `origin_kind` 结构化互斥；M19 既未落地，分两棒落只是徒增一次中间态，合并落每个 Part 仍可独立测（落地顺序 §11）。
> **Baseline commit `677dce0b`**（origin/master 顶端，`style(web): reorder Button import in NavRail`）。本稿 §2 全部事实已逐行核对到此 commit；`677dce0b` 在 `8288ae3f` 基础上多出一批前端 shadcn 迁移（sidebar 重写 / NavRail / breadcrumb / Dialog·Sheet·Tooltip 化 / IssueCard 用 shadcn Button）+ 两处后端修复（auto-title 从 ledger 读、run 表从 eventsDb 查），不动 Issue/orchestrator/conversation 领域逻辑，故各 Part 的代码事实与抓手不变。
> **关键决策（2026-06-22，两轮 grilling + 产品视觉规格确认后）:**
> - **D0→合并为单一里程碑**：dispatcher / `origin_kind`（原 M19）是「接回 projection」（原 M20）的前提，合并落。Part A/B 是 dispatcher 与互斥，Part C~G 是富化/工具/投影/前端。
> - **D1→单一调度入口 `RunDispatcher` + 显式 `origin_kind`**：现状三入口（reactor 自动推进、@提及 fork、manual start）各写各的 `startMainRun`+`insertRunOrigin`，manual 甚至完全不写 origin（§2.3）。抽 `dispatch(cause)` 统一「起 run + 写 `origin_kind`」；`run_origin` 加 `origin_kind ∈ {orchestrator, mention, manual}` 显式起因。落 Part A（§4）。
> - **D2→结构化互斥取代前缀约定**：两个 `onRunComplete`（reactor 推进 vs conversation projection @提及级联）现状靠 `issue:` 前缀 / `issueId` 非空**约定**互斥（§2.5/§2.6）。改为按 `origin_kind` 分派——`orchestrator` 起因才进状态机，`mention`/`manual` 不推进。这是「接回 projection」能安全反转隔离的前提。落 Part B（§5）。
> - **D3→@提及裁决收口到 dispatcher 路径**：「谁被 @」（main.ts 扫描）+「起不起」（service.ts 守卫）现状分居两处；收口为 projection 只产意图、`triggerMentionedAgents` → dispatcher 一处裁决。落 Part B（§5.3）。
> - **D4→Issue 加 `description` + `priority`（P0–P3）+ `estimatedCompletionAt`（可空）**：详情面须展示「描述」「估计完成时间（未填写时显示『未填写』）」，看板卡片须展示彩色优先级角标（如红色 P0）→ 三字段确定加。`priority ∈ {P0,P1,P2,P3}`（产品要求用 P0–P3 而非 low/med/high）。`identifier`（人读编号）不做（卡片用 title 标识，无编号码，§14 Q1）。落 Part C（§6）。
> - **D5→Prompt 渲染改用 Handlebars**：**这条推翻原 M20 的「纯插值无任何 DSL」决策**——应用户 2026-06-22 二次决策「Q6 用 Handlebars 不用 njk」。引入 logic-less 的 Handlebars 取代手写 `{{path}}` 正则，获得 `{{#if}}`/`{{#each}}`/helper 的**有界**表达力（即用户想要的「首棒 vs 返工」分支）。选 Handlebars 而非 Nunjucks 的关键：① **语法同源**——Handlebars 与现状 `{{path}}`/`{{obj.path}}` 完全同形，前端已 seeded 的默认模板（`{{title}}`/`{{issueId}}`/`{{deliverables.<kind>.ref}}`，见 §2.12）**零改即兼容**；② **logic-less by design**——无任意循环/无内联代码/无 `include`/`extends`，本身就比 Nunjucks 更贴近「无 DSL」立身不变量，引擎层面就堵死了无限循环与文件越权。§7.1 记录这是对该不变量的**有界放宽**（非彻底放弃），并给出收敛沙箱（`noEscape`、不注册危险 helper、受控白名单 context、坏模板 try/catch 回退裸原文）。落 Part D（§7）。
> - **D6→frontmatter 不进模板字符串，升级为 ColumnConfig 结构化列**：`executor`/`max_turns`→AgentSpec（用户已同意）；`polling/concurrency/backoff`→编排器全局配置；`approval.posture`→`column_config.approval_posture` 一列。即使采纳 Handlebars（D5），配置仍不走「从 markdown frontmatter 解析」——配置是结构化字段，与「模板引擎是不是 DSL」正交。落 Part D（§7.3）。
> - **D7→只读工具 `get_issue` / `list_issues`，capability-gated，永不写**：复刻 `submit_deliverable` 注入路径加 capability `read_issues`。绝不给 agent 改 status 的工具（单一写者不变量，§3.4）。落 Part E（§8）。
> - **D8→Issue 复用为 Conversation，run 经 projection 落 ledger → 前端 Coding Thread**：`conversationId := issueId`；issue run threadId 从 `issue:<id>` 改 `<issueId>:<agentMemberId>` 走 projection；去掉 `main.ts` 三处 `issue:` 短路，靠 Part B 的 `origin_kind` 互斥兜底。详情面须呈现一张「Coding Thread」卡（含 agent 类型徽章如 `CLAUDE_CODE` + run 状态徽章如 `active` + thread id + 「查看 Coding」深链）即此产物。落 Part F（§9）。
> - **D9→Issue 会话与用户会话列表隔离（`conversation.origin` 列）**：`conversation` 加 `origin TEXT NOT NULL DEFAULT 'user'`（`'user' | 'issue'`），`listConversations` 默认只回 `origin='user'`。issue 创建时建会话（`origin='issue'`, title=issue.title）+ human owner 成员，agent 成员懒加。落 Part F（§9.2/§9.3）。
> - **D10→前端在现有 shadcn 风格上做功能增量（不照设计稿推倒重做）**：保留 `677dce0b` 已迁移的 shadcn 视觉体系（现有配色 token、NavRail、Card/Button/Sheet/Dialog 组件风格一律不动），本棒只补**功能缺口**：看板隐藏 `draft` 列、卡片加 priority 角标 + 描述摘要、详情从居中 Dialog 改右侧 Sheet 抽屉（复用现有 `ColumnConfigPanel` 范式）并补 Coding Thread 卡 / 状态推进按钮 / 编辑 / 删除、看板顶栏加「自动推进」开关。设计稿仅作交互/信息架构参考，**视觉风格以现状为准**。落 Part G（§10）。
> - **D11→编辑/删除写端点本棒含**（详情面须有「编辑」「删除」按钮，原 §14 Q7→是）：`PATCH /api/issues/:id`（改 title/description/priority/eta）+ `DELETE /api/issues/:id`（级联删 `origin='issue'` 会话）。落 Part C/F。
> - **D12→「自动推进」per-board 开关 = 协调器自动推进总闸（用户已确认语义 + 命名）**：看板顶栏有一条「自动推进 Orchestra Beta · 自动推进未启用 · 开始使用→」开关（**UI 文案统一为「自动推进」**，数据列名沿用 `auto_orchestrate`）。用户明确：**这个开关决定协调器（reactor）是否自动起下一棒**。语义落地：关闭时 issue run 完成**不触发** reactor 的状态机推进（`onRunComplete` 入口最前置守卫先读 `project.autoOrchestrate`，false 直接早退，连闸门判定都不走）；issue run 仍正常落 ledger / Coding Thread，仅不级联起下一棒（人工拖拽 / 详情按钮仍可推进）。`project.auto_orchestrate` 一列，默认关（§14 Q4）。**完整接线链见 §7.4**（前端 toggle → http updateSchema → service.update → ProjectRow → 注入 reactor 读取）。落 Part D（§7.4）。
> - **D13→修复前端「渲染 id 而非 displayName」缺陷（Q1 附带，用户本轮追加）**：现状 issue 创建表单的 Project 选择、Project 列配置的 Agent 选择，选中后 base-ui `Select.Value`（`ui/select.tsx`）回显的是 **value（即 id）而非 name**（§2.13）。本棒一并修：给 `Select.Value` 传 children render 把当前 value 映射回 displayName（项目 `name` / agent `name`），归档项保「name (已归档)」。落 Part G（§10.6）。
> **术语:**
> - **RunDispatcher = 起一棒 agent run 的单一机制**：输入起因 cause（kind + threadId + agentId + spec + origin 字段），输出 `supervisor.startMainRun` + `insertRunOrigin(含 origin_kind)`；三入口共用（§3.3）。
> - **origin_kind = 一棒 run 的起因枚举**：`orchestrator`（Issue 状态机推进/返工）| `mention`（对话 @提及）| `manual`（人工起棒），取代「surface + issueId 可空」隐式判别（§3.2）。
> - **Coding Thread = Issue 派生会话在前端的呈现**：Issue 各棒 agent run 的助手消息经 conversation projection 落进 `conversationId=issueId` 的 ledger，前端渲染成一条「编码线程」（详情面的 Coding Thread 卡 + 「查看 Coding」深链），取代 M18.7 的原始 JSON timeline。
> - **read_issues capability = 给 issue run 注入只读 Issue 工具的开关**：与 `submit_deliverable`（只写交付物）正交，注入 `get_issue`/`list_issues`（只读），无任何改 status 工具。
> - **自动推进开关（数据列 `auto_orchestrate`）= reactor 是否自动起下一棒的总闸**：per-Project，关闭时 run 完成不自动起下一棒（看板顶栏显示「自动推进未启用」）。**UI 一律用「自动推进」表述**；数据列名沿用 `auto_orchestrate`（迁移/字段不改名，避免无谓 churn）。
> **关联:** `docs/architecture/backend/orchestrator.md`（current；「@提及与编排两套驱动」收敛为「一个 dispatcher、多个起因」+ 模板渲染从「无 DSL 插值」改为「Handlebars 受控 logic-less 模板」+ frontmatter→ColumnConfig 列；落地后改写并加不变量）· `docs/architecture/conversation/conversation-and-members.md`（current；四道闸收口 dispatcher + `origin` 维度）· `docs/architecture/backend/conversation-projection.md`（current；issue run 从「`issue:` 前缀短路」改为「经 projection 落 ledger、靠 origin_kind 互斥」）· `docs/architecture/backend/run-supervisor.md`（dispatcher 是其上薄层）· `docs/architecture/foundations/issue.md` + `issue-workflow.md`（Issue 字段富化 + Coding Thread 人读面）· `docs/architecture/roadmap/future-work.md:48`（@提及收编标记已落）· 代码见各 Part「影响文件」。

---

## 1. 背景

M18.1~M18.8 把 Issue 协作流骨架立全：Issue 本体 + 存储、Project 实体化、ColumnConfig 派生 per-Project 转移表、草稿态、看板拖拽 + SSE 实时、结构化交付物 + 上下文累积、人工验收闸门 + 返工、Issue Timeline + Issue 级可观测、ColumnConfig 编辑 UI。但还有六处接缝未收，本棒一并处理；其中三处（编排单一权威、接回 projection、前端工作台）互相咬合，必须同棒。

1. **「下一步谁干」有两个权威来源、靠约定隔离**（[orchestrator.md](../../architecture/backend/orchestrator.md):86-97、[future-work.md](../../architecture/roadmap/future-work.md):48 预登记）：reactor 状态机推进 vs @提及级联两套驱动，今天靠 `issue:` 前缀 / `issueId` 非空**约定**互斥（§2.5）。约定一脆就双驱动。且三个起 run 入口各写各的 `run_origin`，manual 完全不写（§2.3）——「这棒为什么起」无统一可查事实。
2. **Issue 太瘦**：`IssueRow` 七字段无 `description`/`priority`/`estimatedCompletionAt`（§2.1）。但目标产品形态要求详情面展示「描述」「估计完成时间」、卡片展示优先级角标（如「P0」）——前端要展示、后端没有这些字段。
3. **Prompt 模板表达力受限**：`renderPrompt` 只 `{{path}}` 纯插值无条件无循环（§2.2）。用户要「首棒 vs 返工」分支等能力 → 决策用 Handlebars（D5；二次决策从 njk 改回更克制的 logic-less Handlebars）。
4. **Agent 看不到 Issue 上下文**：issue run 只有 `submit_deliverable`（只写，§2.4），无「读当前/同 Project 其它 Issue」的眼睛。
5. **「这件活干了啥」不可读**：issue run 被 `issue:` 前缀**有意隔离**出 conversation projection（`main.ts:125/147/207`，§2.5），助手消息不落 ledger；前端只能看原始 JSON timeline。目标产品形态要求详情面有一条人读的「Coding Thread」，必须把这条消息流接回来。
6. **前端缺功能面而非缺风格**：`677dce0b` 已完成 shadcn 迁移，视觉风格保留即可；但详情仍是居中 Dialog（§2.7），卡片无 priority/描述，看板含 draft 列、无自动推进开关、无 Coding Thread 面。本棒在现有风格上补这些功能缺口（详见 §10），**不重做主题、不照设计稿换皮**。

第 1 与第 5 是同一处张力的两面：M18.4 当初**故意**用 `issue:` 前缀隔离 issue run，避免两套驱动打架；要拿到 Coding Thread 就得把 issue run 接回 projection，而接回的前提是先把互斥从「前缀约定」升级为「`origin_kind` 结构化分派」（第 1 点）。这正是 M19 + M20 必须合并的根因。

## 2. 当前代码事实

逐项已与 `677dce0b` 核对：

1. **`IssueRow` 七字段**：`issue/entities.ts` = `{issueId, projectId, title, status, threadId, createdAt, updatedAt}`；`IssueStatus = "draft"|"planned"|"in_progress"|"in_review"|"done"`。`createIssue`（`service.ts:41-54`）收 `{projectId, title}`，`threadId="issue:${issueId}"`。issue 表建于主迁移 `backend_v23_issue`（`infra/sqlite/migrations.ts`，列 = issue_id/project_id/title/status/thread_id/created_at/updated_at）。

2. **`renderPrompt` 纯插值无 DSL**：`orchestrator/render.ts:7-20` `template.replace(/\{\{([\w.]+)\}\}/g,…)`，缺失/非字符串叶子→空串，注释明写「no conditionals, loops, or filters — no template DSL.」。唯一调用点 `reactor.ts:72` `renderPrompt(t.promptTemplate, vars)`，vars 由 `buildPromptVars`（`:48-55`）= `{title, issueId, deliverables.<kind>.fields.<key>, deliverables.<kind>.ref}`。**仓库无 handlebars 依赖**（需新增）。

3. **三入口 run_origin 写法各异**：reactor `startStep`（`reactor.ts:75-97`）写 `{issueId, fromStatus, surface:"orchestrator", idempotencyKey:runId, conversationId:"", sourceLedgerSeq:0}`；@提及 `forkRun`（`conv-svc-factory.ts:87-98`）写 `{conversationId, sourceLedgerSeq, surface, idempotencyKey:`${cid}:${seq}:run`, fromStatus:""}`（无 issueId）；manual `start`（`run/service.ts`）**不写 origin**。`run_origin` 无 `origin_kind` 列。

4. **issue run 只注入 `submit_deliverable`（只写）**：`runner-daemon.ts:197-209`，capability `submit_deliverable` + `sc.issue` + 非 reflect → 注入只写交付物工具（best-effort，失败 `isError:true` 不崩 run）。`supervisor.ts:46` capability 联合类型 = `"start_new_conversation" | "submit_deliverable"`。

5. **issue run 被 `issue:` 前缀短路出 projection + reactor 是 status 单一写者**：`main.ts` 三处 `if (threadId.startsWith("issue:")) return;`（onRunComplete :125 / onRunMessage :147 / onRunEvent :207）。reactor `onRunComplete`（`:108-166`）`const issueId=origin?.issueId; if(!issueId) return;`，成功且 `issue.status===fromStatus` 才 `applyTransition`（`issue/service.ts:56-66`，查 `LEGAL_TRANSITIONS` + CAS）。**status 变更唯一真相源 = reactor `applyTransition`**。

6. **两个 onRunComplete 并排注册、靠约定互斥**：conversation projection（`main.ts:123-127`）+ orchestrator reactor（`main.ts:327-329`）。互斥全靠 `issueId` 非空 / `issue:` 前缀。supervisor `onRunComplete` 是「关键 sink、逐个 await」（`supervisor.ts:178-192`），失败可见不中断后续。

7. **Conversation 是真实体、须显式创建**：`createConversation`（`adapter-sqlite.ts:20-32`）插行；`buildConversation`（`service.ts:70-86`）无行返 null；`Conversation` zod `members.min(1)`；`broadcastMessage` `!conv` 早退。`conversation` 表列 = conversation_id/trigger_mode/hop_count/created_at/title（**无 origin**）。`listConversations`（`:72-99`）`SELECT … ORDER BY created_at DESC`（**无过滤**）。`deleteConversation`（`:101-106`）已会清 threads + 删行。

8. **前端 Issue 面**（`677dce0b` 已是 shadcn 化后状态）：`IssueKanban.tsx` 列来自 `meta.statuses`（5 列含 draft），@dnd-kit 拖拽 + 乐观 + 回滚，禁 `in_review→in_progress` 拖拽。`IssueCard.tsx` 用 shadcn `Card`/`Button`，只 title + 状态徽章 + in_review 行内 Approve/Reject（**仍无 priority 角标 / 描述**）。`IssueDetailSheet.tsx` 实为 **Dialog**（`max-w-2xl` 居中），展示 meta（含 `Thread: {issue.threadId}` 一行，`:147`）/runs/timeline（原始事件）+ SSE，**无 Coding Thread / 状态按钮 / 删除**。`api.ts`：`getIssueMeta/listIssues/getIssue/createIssue/applyTransition/reviewDecision/getIssueDetail`。`globals.css` 暗色 token（`--canvas:#101010 …`）。右抽屉范式 = `ColumnConfigPanel.tsx`（`Sheet side="right"`，已 react-hook-form + zod）；NavRail 已 shadcn sidebar 重写（图标 + tooltip + dropdown）。

9. **migration 最大 id**：主迁移（`infra/sqlite/migrations.ts`）末条 `backend_v26_deliverable` id=5012 → **新迁移从 5013 起**。events 迁移（`run/events-db-migrations.ts`）末条 id=3014 → **run_origin.origin_kind 用 id=3015**。

10. **`Project` 实体**：`project/domain.ts:ProjectRow`（M18.3）。**无 `auto_orchestrate` / counter 列**（自动推进开关、identifier 计数需加列）。`project/service.ts` 的 `update()` patch 类型 = `{name?, repoUrl?, defaultBranch?}`、`project/http.ts` 的 `updateSchema` 同形——**均无 `autoOrchestrate`**（§7.4 接线须补）。

11. **issue HTTP**：`issue/http.ts` 有 `GET /detail → {issue, timeline, runs}`、`POST /deliverables`、`POST /review-decision`、`POST /transition`、`GET /:id`、`GET ?projectId=`。**无 PATCH / DELETE**。

12. **前端已 seeded 的默认 prompt 模板**：`ColumnConfigPanel.tsx` 有 `DEFAULT_PROMPT`（`planned`/`in_progress` 各一段中文起始 prompt）+ `FALLBACK_PROMPT`，均用 `{{title}}`/`{{issueId}}` 语法；编辑区变量提示列 `{{title}}`/`{{issueId}}`/`{{deliverables.<kind>.ref}}`/`{{deliverables.<kind>.fields.<key>}}`。这些是 **Handlebars 同形语法**（D5 选 Handlebars 的直接动因——换引擎零改这批默认模板）。

13. **`Select` 选中回显的是 id 而非 displayName（缺陷）**：`ui/select.tsx:19` 的 `SelectValue` 直接渲染 base-ui `Select.Value`，无 children render → 回显「当前 value」。issue 创建表单 Project 选择（`issues/page.tsx`，`value=p.projectId` 文本 `p.name`）与列配置 Agent 选择（`ColumnConfigPanel.tsx`，`value=a.id` 文本 `a.name`）选中后**触发器显示 id 不是 name**。列配置面板里的「已配置」摘要行另走 `agents.find(...).name` 手动映射（正确），但 Select 触发器本身没修。D13 修这条。

## 3. 第一性原则

### 3.1 统一在调度层，不在领域模型层

「@提及收编进编排」最诱人的误读是「让一切协作都变 Issue」。**拒绝**：Issue 的本质是「有 status 生命周期、按转移表推进、要被验收的活」；@提及是「此刻把话头甩给某 agent」，无 status、无验收、无预定转移。给轻量招呼强加状态机违反[设计哲学](../../architecture/design-philosophy.md)「概念要少」。三者**真正共享**的只有「起一棒 agent run」这个动作，差异仅在「为什么起」。统一共享动作（调度层），不统一领域语义。

### 3.2 起因是显式枚举，不是从 surface + issueId 反推

现状判「为什么起」要看 `surface` + `issueId` 组合（§2.3）：`surface="orchestrator"`→编排起；`surface∈{web,lark}` 且 `issueId` 空→**分不清** mention 还是 manual。这是把「为什么起」（起因）和「在哪跑」（surface）两个正交维度挤进一个字段。给起因一个显式名字 `origin_kind ∈ {orchestrator, mention, manual}`，读侧直接判枚举不再组合推断；`surface` 回归本职。manual 也补写 origin，堵「manual 在 provenance 表缺席」的洞。

### 3.3 单一调度入口 RunDispatcher——一个机制，多个起因

「下一步谁干只有一个权威」落到代码 = **起一棒 run 只有一个机制**。抽 `dispatch(cause)`：统一最后两步 `supervisor.startMainRun` + `insertRunOrigin(含 origin_kind)`——这恰是三入口现在各写一遍、最易写歧的两步。dispatcher 刻意**薄**：不构 spec（各域差异大），不跑业务守卫（要读各域状态），只统一起 run + provenance。放 `run/`（唯一天然归属），被三方 import，不依赖 Issue / conversation 域（避免反向依赖）。

### 3.4 给 agent 读 Issue 的眼睛，绝不给它改 status 的手

Agent 干活需要上下文 → 加只读 `get_issue`/`list_issues`。但**单一 status 写者**是必保不变量：status 只经 reactor `applyTransition`（§2.5）。绝不给 agent 改 status / 推进 / 建 Issue 的工具——否则绕过状态机 + CAS + 人工闸门。工具集 = 只读 + 只写交付物，status 永远是编排器领地。

### 3.5 把 issue run 接回 projection——有意反转 M18.4 隔离，靠 origin_kind 兜底

M18.4 用 `issue:` 前缀隔离 issue run（§2.5），是「没有结构化互斥」下的权宜，代价是 issue run 助手消息不落 ledger → 读不到「这件活干了啥」。本棒反转：issue run threadId 改 `<issueId>:<agentMemberId>` 走 projection、落 `conversationId=issueId` 的 ledger → 前端 Coding Thread。反转之所以安全，**正因为 Part B 已把互斥结构化**：reactor `onRunComplete` 只认 `origin_kind='orchestrator'`（推进状态机），projection `onRunComplete` 只认 `≠'orchestrator'`（投影 + @提及级联），issue run（`orchestrator`）只投影不级联不双推进。这就是 M19 与 M20 必须合并的兑现点：没有 Part B 的 origin_kind，反转隔离会复活双驱动。

### 3.6 Issue 会话与用户会话隔离——同表不同 origin

Coding Thread 的会话（`conversationId=issueId`）是 Issue 内部产物，不是用户发起的聊天，出现在用户对话列表是语义污染。给 `conversation` 一个 `origin` 维度（`'user'|'issue'`），列表默认只回 `'user'`，issue 会话经详情专路读。**不另立表**——issue 会话与用户会话机制完全相同（ledger + members + projection），只是来源不同；为一个枚举建表是过度拆分。

### 3.7 模板引擎：有界放宽「无 DSL」，选 logic-less 的 Handlebars

原 M20 主张保「纯插值无任何 DSL」、用空串兜底吃掉「首棒/返工」分支。用户首轮决策推翻为 njk，二轮又收回：**Q6 用 Handlebars 不用 njk**。这是关键的克制——Handlebars 是 **logic-less** 模板引擎：只有 `{{var}}` 取值 + `{{#if}}`/`{{#unless}}`/`{{#each}}` 这类**有界**块助手 + 命名 helper，**没有任意表达式、没有内联代码、没有任意循环、没有 `include`/`import`/`extends`**。相比 Nunjucks（Jinja 系，带表达式求值、`{% set %}`、文件 loader），Handlebars 在引擎层面就堵死了「无限循环、读任意文件、执行宿主逻辑」这几条最危险的路。

因此 D5 是对「无 DSL」不变量的**有界放宽**而非彻底放弃——拿到用户要的「首棒 vs 返工」条件分支（`{{#if isRework}} … {{/if}}`、`{{#each deliverables}}`），代价被引擎本身的 logic-less 设计先收一道。

第二道：**语法同源，迁移零摩擦**。Handlebars 的 `{{title}}`/`{{deliverables.plan.fields.summary}}` 与现状 `renderPrompt` 的 `{{path}}`/`{{obj.path}}` 完全同形；前端已 seeded 的默认模板（§2.12）**一字不改即兼容**。这正是不选 njk 的实证理由——njk 的 `{{ }}` 虽也同义，但其默认 autoescape、`{% %}` 语句体系与现状差异更大，且能力面更宽（代价更高）。

第三道：**沙箱收尾**（§7.1）：
- `noEscape: true`（prompt 是纯文本，HTML 转义只会污染）。
- 不注册任何危险 helper（默认 Handlebars 不暴露 fs/网络/宿主对象；不引第三方 helper 包）。
- context 是**受控白名单**（issue 字段 + deliverables + rework + attempt），不暴露宿主对象。
- 编译/渲染包 try/catch：模板报错（坏语法）→ 回退到「裸 promptTemplate 原文 + 发 `prompt.render_failed` 事件」，绝不让坏模板崩掉 run（同 `submit_deliverable` 的 best-effort 哲学）。可对编译结果做 LRU 缓存（key=模板字符串）避免每棒重编译。

权衡仍诚实记录在 §13：引入引擎依赖；`{{#each}}` 对超大 deliverables 集合理论上可慢（但无「无限」循环，受数据规模而非模板控制）；模板复杂度靠 review 约束。**这是 §14 Q6 让用户复核的点**——本轮用户已选 Handlebars，§14 Q6 改为「沙箱设定确认」。

### 3.8 配置是结构化字段，与模板引擎是否 DSL 正交

即便采纳 Handlebars（§3.7），配置仍**不**走「从 markdown frontmatter 解析」。`approval.posture` 这类是 per-Project per-status 配置，归 `ColumnConfig` 结构化列；`executor`/`max_turns`→AgentSpec；`polling/backoff`→编排器全局配置。理由：frontmatter 是「需要解析 + 校验 + 错误处理的文本格式」，是另一个迷你 DSL；配置用结构化列 + zod，类型安全、可迁移、可在 UI 表单编辑。「模板能写条件」和「配置是结构化的」是两件事，Handlebars 解决前者，不动后者。

## 4. Part A — RunDispatcher + origin_kind（编排单一权威）

### 4.1 迁移 + 类型

```ts
// run/events-db-migrations.ts —— 追加（当前 max id=3014，§2.9）
{ name: "events_v16_run_origin_kind", id: 3015,
  up: `ALTER TABLE run_origin ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'manual';` }
```
```ts
// runtime-ops/types.ts
export type RunOriginKind = "orchestrator" | "mention" | "manual";
export interface RunOriginRow { /* …existing… */ originKind: RunOriginKind; }
```
`runtime-ops/store.ts`：`RUN_ORIGIN_COLS` 加 `origin_kind AS originKind`；`insertRunOrigin` 多写一列（现有 `INSERT OR IGNORE` 幂等 + 不变量守卫不变）。`DEFAULT 'manual'` 让历史行有合法默认；读侧对历史 issue-driven run 用 `issueId` 非空兜底识别。

### 4.2 dispatcher（新 `run/dispatcher.ts`）

```ts
export type RunOriginInput = Omit<RunOriginRow, "originKind" | "createdAt">;
export type DispatchCause = {
  kind: RunOriginKind;
  runId: string;
  threadId: string;
  spec: Record<string, unknown>;
  opts?: Record<string, unknown>;   // preloadedMessages / surfaceContext / trace
  origin: RunOriginInput;           // 各 kind 的 issueId/conversationId/idempotencyKey 等
};
export function createRunDispatcher(deps: {
  supervisor: RunSupervisor; opsStore: RuntimeOpsStore; now?: () => number;
}) {
  return {
    async dispatch(cause: DispatchCause): Promise<{ runId: string; attemptId: string }> {
      const { attemptId } = await deps.supervisor.startMainRun(
        cause.runId, cause.threadId, cause.spec, cause.opts,
      );
      deps.opsStore.insertRunOrigin({
        ...cause.origin, runId: cause.runId,
        originKind: cause.kind, createdAt: (deps.now ?? Date.now)(),
      });
      return { runId: cause.runId, attemptId };
    },
  };
}
```

### 4.3 三入口接入

- **orchestrator**（`reactor.ts:75-97`）：`startMainRun`+`insertRunOrigin` → 一次 `dispatch({kind:"orchestrator", origin:{issueId, fromStatus:issue.status, surface:"orchestrator", idempotencyKey:runId, conversationId:"", sourceLedgerSeq:0}})`。`run.started` Timeline 埋点位不变。
- **manual**（`run/service.ts` start）：从「不写 origin」→ `dispatch({kind:"manual", origin:{conversationId, agentMemberId, surface:"web", idempotencyKey:runId, issueId:null, fromStatus:""}})`。并发上限守卫留 service。
- **mention**（`conv-svc-factory.ts` forkRun）：surface 判定（Lark roster）保留在闭包构 cause → `dispatch({kind:"mention", origin:{conversationId, sourceLedgerSeq, surface, idempotencyKey:`${cid}:${seq}:run`, issueId:null, fromStatus:""}})`。

**影响文件**：`run/events-db-migrations.ts`、`runtime-ops/{types,store}.ts`、`run/dispatcher.ts`（新）、`orchestrator/reactor.ts`、`run/service.ts`、`conversation/conv-svc-factory.ts`、`main.ts`（构 dispatcher 注入三入口）。

## 5. Part B — 结构化互斥 + @提及裁决收口

### 5.1 reactor 守卫改判 origin_kind

```ts
// reactor.ts onRunComplete :117-119
const origin = opsStore.getRunOrigin(runId);
if (origin?.originKind !== "orchestrator" || !origin.issueId) return;
```

### 5.2 projection 守卫改判 origin_kind

```ts
// projection.ts onRunComplete :170
const origin = opsStore.getRunOrigin(runId);
if (origin?.originKind === "orchestrator") { clearAccumulator(runId); return; }
```
互斥从「`issue:` 前缀 / `issueId` 推断」升级为「`origin_kind` 枚举」。两个监听器各自早退、不合并、不混依赖。**Part F 去掉 `main.ts` 三处 `issue:` 短路后，互斥完全由 origin_kind 承担**（前缀判断作为历史行兜底可暂留，待历史 run 不相关后删）。

### 5.3 @提及裁决路径

projection Phase 3 只产 mention 意图 → `triggerMentionedAgents`（`service.ts`，self/agent 过滤 + hop-cap=8 + active-lock 守卫原位、单点）→ `forkAgentRuns` 的 fork 动作改调 `dispatcher.dispatch({kind:"mention"})`。main.ts 扫描层明确为「只采集 @、不决策」（现状已基本满足，文档化 + 加注释）。hop-cap 仍只对 mention 计；orchestrator/manual 不计 hop。

**影响文件**：`orchestrator/reactor.ts`、`conversation/projection.ts`、`conversation/service.ts`、`conversation/conv-svc-factory.ts`。

## 6. Part C — Issue 字段富化

```ts
// issue/entities.ts
export type IssuePriority = "P0" | "P1" | "P2" | "P3";          // 产品要求（红 P0 角标）
export const ISSUE_PRIORITIES: readonly IssuePriority[] = ["P0","P1","P2","P3"];
export interface IssueRow {
  // …existing…
  description: string;                 // "" = 未填（详情面「描述」字段）
  priority: IssuePriority;             // 默认 P2（中），卡片角标
  estimatedCompletionAt: number | null;// 详情面「估计完成时间」，未填→ null（显示「未填写」）
}
```
- **迁移**（主迁移，从 id=5013 起，§2.9）：`ALTER TABLE issue ADD COLUMN description TEXT NOT NULL DEFAULT ''` + `… priority TEXT NOT NULL DEFAULT 'P2'` + `… estimated_completion_at INTEGER`（可空）。
- **createIssue** 收 `{projectId, title, description?, priority?, estimatedCompletionAt?}`，zod 校验 priority ∈ 枚举。
- **PATCH `/api/issues/:id`**（D11）：改 title/description/priority/estimatedCompletionAt（对应详情面「编辑」按钮）。
- HTTP `getIssue/listIssues/detail` 带出新字段。

`identifier` 不做（§14 Q1）。

## 7. Part D — Prompt 模板（Handlebars）+ 配置结构化 + 自动推进开关

### 7.1 `renderPrompt` 改用 Handlebars（沙箱化，§3.7）

```ts
// orchestrator/render.ts —— 重写为受控 Handlebars
import Handlebars from "handlebars";

// 独立实例，不污染全局；不注册任何第三方/危险 helper。
const hb = Handlebars.create();

// 编译缓存：key=模板字符串，避免每棒重编译（模板集合小且稳定）。
const cache = new Map<string, Handlebars.TemplateDelegate>();

export function renderPrompt(template: string, vars: PromptVars): string {
  try {
    let tpl = cache.get(template);
    if (!tpl) {
      tpl = hb.compile(template, {
        noEscape: true,        // prompt 是纯文本，不做 HTML 转义
        strict: false,         // 缺失变量 → 空串（保留旧「缺失兜底」语义）
        knownHelpersOnly: true,// 只允许内建块助手，禁未知 helper
      });
      cache.set(template, tpl);
    }
    return tpl(vars);
  } catch (e) {
    // 坏模板：回退裸原文 + 发 issue_event("prompt.render_failed")，绝不崩 run
    return template;
  }
}
```
- 依赖：`apps/backend` 加 `handlebars`（自带类型，无需额外 `@types`；`bun add handlebars`）。
- context（`buildPromptVars`，`reactor.ts`）富化为白名单：

```ts
return {
  issue: { title, description, priority, id: issue.issueId,
           status: issue.status, estimatedCompletionAt: issue.estimatedCompletionAt },
  deliverables: byKind,                       // {{ deliverables.plan.fields.summary }}
  rework: { note: byKind.rework_feedback?.fields?.note ?? "" },
  attempt: byKind.rework_feedback ? 2 : 1,
  isRework: !!byKind.rework_feedback,         // {{#if isRework}} … 返工分支 … {{/if}}
  // 向后兼容：扁平 title/issueId 保留，现有 ColumnConfig 模板（§2.12）零改
  title: issue.title, issueId: issue.issueId,
};
```
- 现有 `{{title}}` / `{{deliverables.x.fields.y}}` 模板在 Handlebars 下**语法同形、语义兼容**（§2.12 前端 seeded 默认模板零改）；新模板可用 `{{#if isRework}}`/`{{#each deliverables}}` 等有界块助手。
- 测试：迁移 `render.test.ts` 现有用例须全绿（兼容回归）+ 加条件（`{{#if}}`）/循环（`{{#each}}`）/缺失变量/坏模板回退用例。

### 7.2 `render.ts` 的 `PromptVars` 类型放宽为 `Record<string, unknown>`（Handlebars context 不限叶子为 string）。

### 7.3 frontmatter → `column_config.approval_posture` 结构化列（§3.8）

```ts
export type ApprovalPosture = "auto" | "human";
// 迁移：ALTER TABLE column_config ADD COLUMN approval_posture TEXT NOT NULL DEFAULT 'auto'
```
- 默认 `auto`；`in_review` 列默认 `human`（或保 `HUMAN_GATES` 兜底）→ **默认行为零变**。
- M18.8 ColumnConfig 编辑 UI 加 `approval_posture` select。
- **接线链（自洽前提）：** 现状 reactor 的闸门判定**唯一**走 `transitions.ts` 的 `nextTransition(table, from)`，它**硬编码** `if (HUMAN_GATES.has(from)) return undefined`；而 `column-config/service.ts` 的 `transitionsForProject` 派生出的 `Transition` **不携带 `approval_posture`**。所以「reactor 按列判闸门」当前无从读起。要接线需：① `column-config/{domain,adapter-sqlite}.ts` 加 `approvalPosture` 列读写；② `Transition` 类型（`transitions.ts`）加 `approvalPosture` 字段，`transitionsForProject` 派生时带出；③ `nextTransition` 的闸门判定从「`HUMAN_GATES.has(from)`」改「该 from 对应 Transition 的 `approvalPosture==='human'`，无配置时回退 `HUMAN_GATES`」。**若本棒只加列不接线（见 §14 Q3 的范围选择），则 ②③ 不做、reactor 行为不变**——但那样该列就是「已存储未生效」，须在 §14 Q3 明确取舍。
- 接线范围（reactor 读列判闸门 vs 只加列不接线）见 §14 Q3（已定 = 接线）。

### 7.4 「自动推进」per-board 开关 = 协调器自动推进总闸（§D12，看板顶栏「自动推进 Orchestra Beta」）

> **命名：** UI / 文案一律「**自动推进**」；数据列 / 字段沿用 `auto_orchestrate` / `autoOrchestrate`（不改名，避免迁移 churn）。
>
> **自洽前提（本轮 wiring 审计补）：** 现状 `reactor.ts` 的 `OrchestratorDeps`（`{issueSvc, agentSvc, supervisor, opsStore, buildSpec, idGen, columnConfigSvc, deliverableSvc, now?}`）**不含 `projectSvc`**，`onRunComplete` 拿不到 project 配置；`project/service.ts` 的 `update()` patch 类型 = `{name?, repoUrl?, defaultBranch?}`、`createProject` 入参、`project/http.ts` 的 `updateSchema` 三处**都没有 `autoOrchestrate`**。所以「reactor 读 `project.autoOrchestrate`」与「前端 PATCH 写开关」**两端目前都未接线**——必须按下面五段把链路补全，否则该开关是死配置。

```ts
// project/domain.ts ProjectRow 加：autoOrchestrate: boolean
// 迁移（主迁移，从 id=5013 起，§2.9）：
//   ALTER TABLE project ADD COLUMN auto_orchestrate INTEGER NOT NULL DEFAULT 0  (默认关，§14 Q4)
```

**端到端接线链（缺一段开关即不生效）：**

1. **数据层** — `project/domain.ts` `ProjectRow` 加 `autoOrchestrate: boolean`；`project/adapter-sqlite.ts` 读时 `auto_orchestrate` → boolean（`=== 1`）、`createProject` 写时 boolean → `0|1`、`updateProject` 支持该列条件更新；迁移加列（默认 0）。
2. **HTTP 入口** — `project/http.ts` `updateSchema` 加 `autoOrchestrate: z.boolean().optional()`（**当前 schema 缺它，zod 会把该字段 strip 掉，前端 PATCH 静默失效**）；`createSchema` 可选同补。
3. **服务层** — `project/service.ts` `update()` 的 patch 类型加 `autoOrchestrate?: boolean` 并透传给 `port.updateProject`（**当前 patch 类型不含它，传进来也不会落库**）；`createProject` 入参加 `autoOrchestrate?`（默认 false）。
4. **注入 reactor** — `reactor.ts` `OrchestratorDeps` **加 `projectSvc: { getById(id): ProjectRow }`**（或更窄的 `readAutoOrchestrate(projectId): boolean`，按最小依赖取窄）；`main.ts` 构 `createOrchestrator({...})` 时把已存在的 `projectSvc`（main.ts:288 已构造）**传进去**（**当前 main.ts:330-339 没传**）。
5. **reactor 守卫** — `onRunComplete` **最前置**（在读 origin / origin_kind / 闸门之前）：
   ```ts
   const issue = issueSvc.port.getIssue(issueId);
   if (!issue) return;
   const project = await projectSvc.getById(issue.projectId).catch(() => null);
   if (!project?.autoOrchestrate) return;   // 自动推进关 → 不级联起下一棒
   ```
   注意取 `issue.projectId` 需先拿到 issue，故守卫位置在「确认 issueId/issue 存在」之后、「判 origin_kind 推进」之前；但**早于** `applyTransition`，确保关闭时连状态机都不走。

- 关闭时 issue run 仍正常落 ledger / Coding Thread（projection 路径不受 reactor 守卫影响），仅「自动推进」被关；人工拖拽 / 详情状态按钮（走 issue HTTP transition，不经 reactor 守卫）仍可推进。
- 与 `approval_posture`（§7.3）正交：auto_orchestrate 是「要不要自动起下一棒」总闸，approval_posture 是「某列推进要不要人工闸门」。总闸关则无所谓闸门。
- 前端看板顶栏开关（文案「自动推进未启用 · 开始使用→」）：`PATCH /api/projects/:id { autoOrchestrate }`，回写后刷新 `project`。
- 默认值 = **关**（§14 Q4），即首次进入显示「未启用」状态。

**影响文件（本节）**：`project/{domain,ports,service,http,adapter-sqlite}.ts`、`infra/sqlite/migrations.ts`、`orchestrator/reactor.ts`（`OrchestratorDeps` 加 `projectSvc` + `onRunComplete` 守卫）、`main.ts`（`createOrchestrator` 注入 `projectSvc`）。

**影响文件**：`orchestrator/render.ts`、`orchestrator/reactor.ts`、`column-config/*`、`project/{domain,ports,service,http,adapter-sqlite}.ts`、`infra/sqlite/migrations.ts`、`apps/backend/package.json`（加 `handlebars`）。

## 8. Part E — 只读 Issue 工具

- `supervisor.ts:46` capability 联合类型加 `"read_issues"`；reactor 起 issue run 时 capability 从 `["submit_deliverable"]` → `["submit_deliverable","read_issues"]`。
- `runner-daemon.ts`（紧跟 `submit_deliverable` 注入块）：`read_issues` + `sc.issue` + 非 reflect → 注入 `createGetIssueTool`（GET `/api/issues/:id`，只读快照含 status）+ `createListIssuesTool`（GET `/api/issues?projectId=`，只读列表）。失败 `isError:true` 不崩 run。
- **无任何 mutation 工具**（§3.4 不变量）。新文件 `packages/runner-daemon/src/{get-issue-tool,list-issues-tool}.ts`。

**影响文件**：`run/supervisor.ts`（类型）、`orchestrator/reactor.ts`（capability）、`packages/runner-daemon/src/runner-daemon.ts` + 两个新工具文件。

## 9. Part F — Issue ↔ Conversation 投影与隔离

### 9.1 threadId 改形 + 去短路
- issue run threadId 从 `issue:<id>` 改 `<issueId>:<agentMemberId>`（reactor `startStep`，`agentMemberId = t.agentId`）。
- 去掉 `main.ts` 三处 `if (threadId.startsWith("issue:")) return;`（:125/:147/:207）——issue run 经 projection 落 ledger。互斥由 Part B 的 origin_kind 承担（§5.2）。
- **`IssueRow.threadId` 字段去留（§14 Q5「这个 threadId 用在哪里」的答复）**：全仓只有两处真用到它——① `reactor.ts:73-75` 把 `issue.threadId` 当作该 issue 所有 run 的 thread id 传给 `buildSpec` + `startMainRun`（**功能性，不可删**：它就是 issue↔run 的线程归属键，改形后值变 `<issueId>:<agent>`，承载「同一 issue 的多棒 run 同线程」）；② `IssueDetailSheet.tsx:147` 纯展示 `Thread: {issue.threadId}`（**展示性**，前端改为不展示 `issue:` 字样、或直接移除该调试行）。其余命中均为 conversation 自己的 threadId（`<conversationId>:<memberId>`，与 issue 无关）。结论：**保列**——它是 reactor 起棒的线程键，概念上即 `conversationId=issueId` 的派生，删列会断 reactor 起棒路径。

### 9.2 `conversation.origin` 列 + 列表过滤
```sql
ALTER TABLE conversation ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';  -- 'user'|'issue'
```
- `createConversation` 入参加 `origin?`（默认 `'user'`）；`listConversations` 加 `WHERE origin='user'`；`getConversation`/`listConversationsByAgent` 不过滤（详情专路可读）。`ConversationRow`/`CreateConversationInput` 加 `origin`。

### 9.3 Issue 创建时建会话 + 懒加成员
- issue 创建后：`createConversation({conversationId:issueId, origin:"issue", createdAt})` + `setConversationTitle(issueId, title)` + `addMember({conversationId:issueId, memberId:"owner", kind:"human", displayName:"Owner"})`（满足 `members.min(1)`）。
- agent 成员懒加：reactor `startStep` 起某 agent 棒**前** `addMember({conversationId:issueId, memberId:t.agentId, kind:"agent", agentId:t.agentId})`（幂等 INSERT OR IGNORE）。
- 这样 projection `buildConversation` 永不返 null、`broadcastMessage` 不早退。

### 9.4 Coding Thread 读路 + 删除级联
- 复用 thread-projection 读 + SSE（优先）或加 `GET /api/issues/:id/thread`（按 `conversationId=issueId` 取 ledger → 人读消息列表）。`api.ts` 加 `getIssueThread` + SSE 订阅。
- `DELETE /api/issues/:id`（D11）：删 issue 行 + 级联 `deleteConversation(issueId)`（已会清 threads + 会话行，§2.7），避免孤儿。

**影响文件**：`issue/{service,http,adapter-sqlite}.ts`、`orchestrator/reactor.ts`、`conversation/{adapter-sqlite,ports,service}.ts`、`main.ts`、`apps/web/src/lib/api.ts`。

## 10. Part G — 前端功能增量（保留现有 shadcn 风格，本棒重点）

> **原则：不重做主题、不照设计稿换皮。** `677dce0b` 已完成 shadcn 迁移，现有配色 token、NavRail、Card/Button/Sheet/Dialog/Tooltip 组件风格一律保留；本节只描述**功能与信息架构的增量**，所有新元素复用现有组件与现有视觉风格。设计稿仅作交互参考，视觉以现状为准。

### 10.1 主题：不动
保留 `globals.css` 现有 token（§2.8）与现有亮/暗风格，**本棒不新增主题、不改配色体系**。新组件（priority 角标、自动推进开关、Coding Thread 卡）一律用现有 shadcn 组件 + 现有 token 着色（如 `Badge`/`Card`/`Switch`/`Button` 的既有 variant），保证与现状视觉一致。

### 10.2 导航：沿用现有 NavRail
沿用 `677dce0b` 已 shadcn 化的 NavRail（图标 + tooltip + dropdown），**本棒不改导航结构与样式**。若「编码」入口尚不存在且 Coding Thread 深链需要它，仅按现有 NavRail 既定范式补一个同风格入口项，不重排为新布局。

### 10.3 看板：隐藏 draft 列 + 顶栏自动推进开关 + 卡片富化（沿用现有 `IssueKanban` 样式）
> 在现有 `IssueKanban.tsx`（已含拖拽 + SSE + 乐观回滚）基础上做增量，列容器/卡片/拖拽样式保留。

**视觉准则（用现有 shadcn 组件 + 现有 token 实现，不另起主题）：** 横向多列看板布局，每列代表一个任务状态；列间用较大横向间距分隔，整体轻量、留白充足。每列用**深色描边 + 大圆角**容器承载内容，形成清晰但不厚重的分区。空列不留纯空白，用轻量占位提示「可将 Issue 拖入该状态」。整体风格：**极简 / 低饱和 / 高留白 / 轻边框 / 大圆角 / 状态标签彩色点缀**，强调任务状态流转而非复杂信息堆叠。若现有 token 与上述观感冲突（如边框过重、圆角过小），在不改主题色板的前提下微调列容器的描边/圆角/间距即可，不新增配色体系。

- 列：现状 5 列（含 draft）→ **隐藏 draft 列**，只上板 `计划中 / 开发中 / 待 Review / 已完成`（`draft` 收进 Inbox 入口，草稿未排程）。列来源 = `meta.statuses` 过滤 draft（或后端 `boardStatuses`）。空列轻量占位「拖拽 Issue 到这里」。
- 顶栏：现有顶栏增加一个**自动推进开关**（见下条）；其余（项目切换、创建 Issue 等现有入口）保留不动。
- **自动推进开关**（§7.4）：用现有 `Switch`/`Button` 组件加一条「自动推进（Orchestra Beta）· 未启用 → 开始使用」开关，绑 `PATCH /api/projects/:id { autoOrchestrate }`，回写后刷新当前 project 的 `autoOrchestrate` 状态，样式随现有顶栏风格。**接线依赖 §7.4 全链**（http updateSchema / service.update 须先支持 `autoOrchestrate`，否则 PATCH 被 zod strip、开关无效）。
- 卡片（`IssueCard.tsx`，现为 shadcn Card/Button）：视觉层级须清晰——**标题**较深色、较粗字体作主信息；**描述**淡色小字号作次级信息；**标签**用彩色背景/文字突出状态与优先级。在现有 title + 状态徽章 + in_review 行内 Approve/Reject 基础上**增**：描述摘要（淡色小字、单/双行截断）+ **priority 角标**（用现有 `Badge`，彩色点缀 P0 红 / P1 橙 / P2 蓝 / P3 灰，取现有语义色 token）。拖拽乐观 + 回滚 + 禁 `in_review→in_progress` 拖拽保留。

### 10.4 详情：Dialog → 右侧 Sheet 抽屉 + 补功能（复用现有 `ColumnConfigPanel` Sheet 范式）
`IssueDetailSheet.tsx` 从现有居中 Dialog 改 `Sheet side="right"`（**复用 `ColumnConfigPanel` 的现有 Sheet 范式与样式**），在现有 meta/runs/timeline + SSE 之上补功能区：
- **头**：title + 右上「编辑」按钮（D11 PATCH）+ 关闭 ✕（沿用现有 Sheet 头样式）。
- **属性表**：状态徽章 / 创建时间 / **估计完成时间**（未填写→「未填写」）/ 描述 / **Token 用量**（聚合该 issue **所有 run**的 prompt+completion token，**含 reflect run**——§14 Q2「一起计算」）。
- **Coding Thread 卡**（用现有 Card）：issue 标题 + agent 类型徽章（如 `CLAUDE_CODE`）+ run 状态徽章（如 `active`）+ 完成标 +「查看 Coding」深链 + 可复制 thread id。数据源 = §9.4 Coding Thread 读路。**「查看 Coding」深链目标 = 该 issue 对应的 conversation（§14 Q7 确认）**：因 `conversationId=issueId`，深链跳「编码」页并定位 `conversation=issueId`（即把 issue 派生会话当成一个普通会话打开看完整对话）。
- **状态推进按钮**（用现有 Button）：按 `LEGAL_TRANSITIONS[issue.status]` 渲染（如「移动到计划中 / 移动到开发中 / 移动到已完成」），含 `in_review→in_progress` 返工（仅按钮、不拖拽）。
- **删除**：现有 Button 的 destructive variant「删除」（D11 DELETE，级联删 issue 会话）。
- 现有 Timeline/Runs（原始事件）作为次级「调试」面保留（不再是唯一面）。

### 10.5 字段编辑
- 创建表单：title + description（textarea）+ priority（select）+ estimatedCompletionAt（可选日期）。
- 编辑：详情「编辑」→ PATCH。

### 10.6 修复 Select 回显 id → displayName（§D13，Q1 附带）
- 现状（§2.13）：base-ui `Select.Value`（`ui/select.tsx:19`）无 children render，选中后触发器回显的是 **value（id）而非 name**。
- 修法：让 `SelectValue` 支持 children render，把当前 value 映射回 displayName。两处调用点各传映射：
  - issue 创建表单 Project 选择（`issues/page.tsx`）：`value=projectId` → 显示 `projects.find(p=>p.projectId===v)?.name ?? v`。
  - 列配置 Agent 选择（`ColumnConfigPanel.tsx`）：`value=agentId` → 显示 `agents.find(a=>a.id===v)?.name ?? v`，归档项保「name (已归档)」。
- 优先在 `ui/select.tsx` 的 `SelectValue` 包一层「value→label」能力（base-ui `Select.Value` 接受 children 为 `(value)=>ReactNode`），避免每个调用点各写一遍。

**影响文件**：`IssueKanban.tsx`（隐藏 draft 列 + 顶栏自动推进开关）、`IssueCard.tsx`（priority 角标 + 描述）、`IssueDetailSheet.tsx`（Dialog→Sheet + 补功能）、`apps/web/src/lib/api.ts`、`apps/web/src/components/ui/select.tsx`（D13）、`issues/page.tsx` + `ColumnConfigPanel.tsx`（D13 调用点 + 创建/编辑表单字段）、自动推进开关组件。**不动 `globals.css` 主题与 NavRail 结构/样式**（仅当「编码」入口缺失时按现有范式补一项）。

## 11. 落地顺序

> 原则：先后端纯数据/无行为变更，再 dispatcher 与互斥（行为零变搬家），再接回 projection（高风险反转，依赖前两步），最后前端。每步 `bun test` 绿再进。

- **第 0 步**：baseline 已切 `677dce0b`（origin/master 顶端），§2 事实已逐行核对到此 commit；落地从 Part A 直接开始。
- **Part A**（§4）：origin_kind 迁移 + 类型 + dispatcher + 三入口接入。既有测试不回归（行为零变）。
- **Part B**（§5）：结构化互斥 + @提及裁决收口。@提及 e2e + Issue e2e 双证零回归。
- **Part C**（§6）：Issue 三字段 + PATCH。纯增量。
- **Part D**（§7）：拆为 5 个可独立验收子任务，**按序落、每个 `bun test` 绿再进下一个**：
  - **D-1 Handlebars 重写 render**（§7.1/7.2）：`orchestrator/render.ts` 换 Handlebars 沙箱 + `buildPromptVars` 富化白名单 + `apps/backend` 加 `handlebars` 依赖。验收：§12「Handlebars」全组（现有 render 用例零回归 + `{{#if isRework}}` + `{{#each}}` + 缺失变量空串 + 坏模板回退 + `knownHelpersOnly` 拒未知 helper）。**与 D-2~D-5 无依赖，可最先落**。
  - **D-2 approval_posture 加列**（§7.3 第①步）：`column-config/{domain,adapter-sqlite}.ts` 加 `approvalPosture` 列读写 + 主迁移加列（默认 `'auto'`）+ M18.8 编辑 UI 加 select。验收：列默认值；读写往返；**reactor 行为此刻仍零变**（未接 nextTransition）。
  - **D-3 approval_posture 接线判闸**（§7.3 第②③步，**依赖 D-2**）：`transitions.ts` `Transition` 加 `approvalPosture` + `transitionsForProject` 派生带出 + `nextTransition` 闸门判定改「`approvalPosture==='human'`，无配回退 `HUMAN_GATES`」。验收：§12「approval_posture」——`in_review` 默认 human 行为零回归 + 某列配 `human` 时 reactor 不自动推进。**此子任务可按 §14 Q3 取舍：若决定本棒只加列不接线，则跳过 D-3**。
  - **D-4 auto_orchestrate 数据+读写全链**（§7.4 第 1~3 段）：`project/{domain,adapter-sqlite}.ts` 加 `autoOrchestrate` 读写 + 主迁移加列（默认 0）+ `project/http.ts` `updateSchema`(+`createSchema`) 加 `autoOrchestrate: z.boolean().optional()` + `project/service.ts` `update()`/`createProject` 透传。验收：§12 auto_orchestrate 专测①「PATCH `{autoOrchestrate:true}` → service.update 落库 → `getById` 读回 true」证 http→service→adapter 全链。
  - **D-5 auto_orchestrate 注入 reactor + 守卫**（§7.4 第 4~5 段，**依赖 D-4**）：`reactor.ts` `OrchestratorDeps` 加 `projectSvc`（或窄接口 `readAutoOrchestrate`）+ `onRunComplete` 最前置守卫早退 + `main.ts` `createOrchestrator` 注入已有 `projectSvc`（main.ts:288）。验收：§12 auto_orchestrate 专测②「`autoOrchestrate=false` 时 `onRunComplete` 最前置早退、不 `applyTransition`；`true` 时正常推进」。
- **Part E**（§8）：read_issues capability + 两只读工具。
- **Part F**（§9，**依赖 A/B**）：threadId 改形 + 去 `issue:` 短路 + origin 列 + 建会话/懒加成员 + Coding Thread 读路 + DELETE 级联。**最危险**：Issue 全生命周期 e2e + 多 agent @提及 e2e 双证「不双推进、不误级联」。
- **Part G**（§10，**保留现有 shadcn 风格、不重做主题**）：看板隐藏 draft 列 + 顶栏自动推进开关 + 卡片富化（priority/描述）→ 详情 Dialog 改右侧 Sheet + Coding Thread + 状态按钮 + 删除/编辑 → Select 回显 id→name 修复（D13）。
- **测试 + 文档**（§12 + 关联）。

## 12. 测试

- **dispatcher**：三 kind dispatch → startMainRun 被调 + insertRunOrigin 写对 originKind + 各字段；坏 origin 守卫冒泡。
- **互斥**：orchestrator 起因 run 完成 → reactor 推进 + projection 不级联；mention/manual → reactor 不推进。manual start 现写 origin（`originKind==='manual'`）回归。
- **@提及 e2e**：互 @ 起棒（`mention`）、hop-cap 第 9 跳触顶、self-guard、active-lock。
- **字段**：create 带/不带默认值；priority 非法被拒；PATCH 改字段；detail 带出。
- **Handlebars**：现有 render 用例全绿（兼容——§2.12 默认模板零改）；`{{#if isRework}}` 返工分支；`{{#each deliverables}}`；缺失变量空串；坏模板回退裸原文 + 发 `prompt.render_failed` 事件；`knownHelpersOnly` 拒未知 helper。
- **approval_posture / auto_orchestrate**：默认值；（接线后）reactor 按列判闸门 / 关闭自动推进不级联——默认行为零回归。auto_orchestrate 专测：① PATCH `{autoOrchestrate:true}` → service.update 落库 → `getById` 读回 true（证 http→service→adapter 全链）；② reactor 注入 `projectSvc`，`onRunComplete` 在 `autoOrchestrate=false` 时**最前置早退、不 applyTransition**；`true` 时正常推进。
- **只读工具**：get_issue/list_issues 只读快照；无 mutation 路径；失败不崩 run。
- **接回 projection（关键）**：issue run 完成 → 助手消息落 `conversationId=issueId` ledger（Coding Thread 有内容）；issue run 不跑 @提及级联、不重复推进；`listConversations` 不含 `origin='issue'`；详情专路能读；DELETE 级联删会话无孤儿。
- **前端**：看板隐藏 draft 列（仅上板 4 状态）；卡片 priority/描述；自动推进开关；详情 Sheet（属性表 + Token 用量 + Coding Thread 卡 + 状态按钮 + 编辑/删除）；Coding Thread SSE 追加；**现有 shadcn 风格/主题不回归改动**；**Select 选中后触发器显示 name 不是 id**（Project 选择 + Agent 选择，含归档项「name (已归档)」，D13）。
- **门槛**：`bun test` 全绿；`turbo run build` 后 `lint`/`typecheck` 通过；Issue 全生命周期 e2e（M18.1~M18.8）零回归。

## 13. 风险与权衡

- **接回 projection 复活双驱动（最高）**：去 `issue:` 短路后若 origin_kind 互斥不到位 → reactor 推进 + projection 级联同时反应。缓解：Part F 严格在 A/B 之后；e2e 双证。权衡：拿 Coding Thread 的必付代价，靠 origin_kind + 测试兜底。
- **Handlebars 引入有界 DSL（有界放宽不变量，§3.7）**：模板可写条件/循环/helper。但 Handlebars 是 logic-less：无任意循环、无内联代码、无文件 loader——引擎层面就堵死无限循环与越权读文件。缓解：`noEscape` + `knownHelpersOnly`（不注册危险 helper）+ 白名单 context + 坏模板 try/catch 回退裸原文 + 事件 + 编译缓存。残余面：`{{#each}}` 对超大 deliverables 集合理论上慢（受数据规模而非模板控制，非「无限」），模板复杂度靠 review。权衡：用户明确二次决策选 Handlebars（比 njk 更克制）；语法同源使现有模板零改。**§14 Q6 让用户复核沙箱设定**。
- **「搬家」式重构隐性漂移**：startMainRun/insertRunOrigin 三处搬一处易漏字段（mention 的 preloaded、orchestrator 的 surfaceContext.issue）。缓解：§4 逐字段列；Part A 分步 + e2e。
- **migration DEFAULT 'manual' 标错历史 issue run 起因**：缓解：读侧 issueId 兜底；不写回填（历史 run 已终态）。
- **懒加成员时序**：agent 成员在首次 dispatch 前补加，创建时即建会话行 + human owner 满足 min(1)。
- **Token 用量聚合口径**：详情面「Token 用量」（如 2.8K）需定义聚合源 = 该 issue 所有 run 的 prompt+completion token 求和、含 reflect（§14 Q2 已定）。
- **范围大**：后端 6 Part + 前端功能增量。缓解：§11 分 Part 小步独立测；前端保留现有 shadcn 风格、只补功能（不重做主题）已显著收窄；Q3/Q4 可再缩范围。权衡：用户要求合并 + 前端重点，按全集起草、用拍版收窄。

## 14. 拍版结论（2026-06-22 已定）

七问已全部定案，本稿正文已据此回填；下表存档决策与影响落点，便于追溯。

| # | 议题 | 决策 | 落点 |
|---|------|------|------|
| **Q1** | `identifier`（人读编号）做不做 | **不做**（卡片用 title 标识，无编号码；YAGNI）。**附带：** 一并修前端 Select 选中后回显 id 而非 displayName 的缺陷（issue 建表选 Project、Project 列配置选 Agent 两处） | §6（不做 identifier）；**D13 / §2.13 / §10.6**（Select 回显修复） |
| **Q2** | Token 用量聚合口径（详情面「2.8K」） | **该 issue 所有 run 求和，含 reflect run**（「一起计算」）——最直观反映这件活的总开销 | §10.4（聚合 prompt+completion，覆盖 main + reflect 全部 run） |
| **Q3** | `approval_posture` 接线到哪步 | **B**：加列 + reactor 按列判闸门，`HUMAN_GATES` 退为兜底默认；`in_review` 默认仍 human → 行为零变 + 获 per-Project 可配 | §5 / §6（reactor 读 `approval_posture` 列） |
| **Q4** | 「自动推进」开关语义 + 默认值 + 命名 | **默认关**；UI 文案统一「自动推进」（数据列 `auto_orchestrate` 不改名）；语义即该开关**直接决定协调器/reactor 是否自动起下一棒**：关 → reactor `onRunComplete` 最前置守卫早退、不级联推进；开 → 正常自动推进。**完整端到端接线**（reactor `OrchestratorDeps` 加 `projectSvc` + main.ts 注入 + project http/service/adapter 加 `autoOrchestrate`）见 §7.4 | §7.4（`auto_orchestrate` 默认 0，reactor 最前置守卫早退 + 五段接线链）；§3.8 / D12 |
| **Q5** | `IssueRow.threadId` 字段去留 | **保列**（已答 Q5）。实际仅两处用：`reactor.ts:73-75`（issue↔run 线程键，功能性、不可删）+ `IssueDetailSheet.tsx:147`（仅展示）。概念被 `conversationId=issueId` 取代但列须保 | §9.1（用途清点 + 保列结论） |
| **Q6** | 模板引擎选型 | **改用 Handlebars，不用 Nunjucks**：logic-less、语法与现有 `{{path}}`/`{{obj.path}}` 完全一致 → **前端已 seed 的默认 prompt 模板零改动**；按 §7.1 沙箱（`noEscape`/`strict:false`/`knownHelpersOnly`/无危险 helper/编译缓存/失败回退原文）落地 | **D5 / §3.7 / §7.1**（Handlebars 替换 `renderPrompt`） |
| **Q7** | Coding Thread「查看 Coding」深链目标 | **跳对应 conversation**（`conversationId=issueId`），定位到该会话；抽屉内只放摘要卡 | §10.4（深链 → conversation） |

## 15. 关联页面

- [Orchestrator](../../architecture/backend/orchestrator.md)
- [对话与成员](../../architecture/conversation/conversation-and-members.md)
- [会话投影](../../architecture/backend/conversation-projection.md)
- [Run Supervisor](../../architecture/backend/run-supervisor.md)
- [Issue 本体](../../architecture/foundations/issue.md)
- [Issue 协作工作流](../../architecture/foundations/issue-workflow.md)
- [未来工作](../../architecture/roadmap/future-work.md)
- [架构设计哲学](../../architecture/design-philosophy.md)
