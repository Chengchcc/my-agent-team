# 审计整改计划（2026-11-24 起）

跟审计 `results.md` 的"当前最应修的缺口"与四份报告（frontend / product / ux / adr0074）。
勾选表示**已实现、已部署、CI 绿**；未勾选的写清依赖（改前端？改后端？要 ADR？）。

---

## A. 已修（已部署）

- [x] AHP 取票等待期关闭仍建连 → 审计自己的探针现在断言失败
- [x] 有历史的房间新消息不乐观显示（`echoBaseline`）
- [x] Monaco JSON worker 相对 URL（绝对 base）
- [x] 会话加载期假空态 / 指挥台假零 / 侧栏假空
- [x] Skills `Ready` 服从真实目录校验
- [x] personal 不进 brief（`excludeSections`）
- [x] agent 创建不被预同意（测试钉住）
- [x] Fork：`run:<id>:assistant` 回复不再被丢
- [x] 导出可读 Markdown + 导出期间禁用 + 失败原因
- [x] 404 带壳、时长人话、heap 哨兵、中英文切换
- [x] RUNNING 筛选空态按筛选命名
- [x] `(main)/error.tsx`：页面崩在壳内替换
- [x] AHP 每轮 finally shutdown
- [x] 顶栏未测量前显示 Checking
- [x] Settings DATA DIR 显示真实路径；RUNTIME 三态
- [x] Skills validate：非 2xx / 空结果明确
- [x] Workflow Run 被拒原因前置（`scriptNodesBlocked`）
- [x] 终端工具栏纯图标 aria-label
- [x] MCP 空态按钮名（Connect Server）
- [x] Auto 更名为「模型：跟随成员设置」
- [x] 终态不再写 STREAM ACTIVE；徽章改「实时跟随／已暂停」
- [x] 同一 run 列表/详情时长同源（用真实 `terminalAt`，缺失显示 `—`）
- [x] Artifacts `Buckets 0` 口径说明
- [x] Today 完成项带房间标题（三条同题可区分）
- [x] Inbox 顶端一句「把目标告诉 Personal Agent…」
- [x] 执行单元折叠块：每行带**目标**（requirement 标题）、判据（检查通过/工具报错）、Run 深链
- [x] 交付黄条写明判据边界（只认「另一成员之后完成且未改文件」）
- [x] 自动建事项的 goal 不再承诺「refine here」（详情页没有编辑器）
- [x] 事项状态派生：按 owner 判「等你」；验收只看**最新一次**尝试
- [x] Activity 的 Recent Runs 标注口径（该成员跨房间最近 50 次）
- [x] 事项详情可「标记完成 / 取消」（确认后 PATCH，显示派生值与存储值）
- [x] 唤醒失败把待答请求的 owner 转给人（`escalateActionToUser`，记 `escalatedAt`）
- [x] 搜索命中片段开窗（`windowAround` + 测试）

## B. 下一批（M1：派活与收货）

1. [x] **执行单元折叠块**：一行显示目标、作者、改动文件数、最新交付、检查/互审深链；缺证据明示（前端 + 后端投影）
2. [x] **交付固定 revision 的 Diff**：`project_push` 记 `project_delivered{projectId,branch,commits,compareUrl}` 事件；未核验黄条带分支与 compare 链接：复用 Project Diff，明确"历史交付 ≠ 当前副本"
3. [x] **交付黄条**：写明判据有限（`delivery-gate` 只判"另一成员完成且未改"），可回查 revision
4. [ ] **Chat 索引页**空态引导（选择或新建）——已有描述与加载行，待补空态
5. [x] 「refine here」虚构承诺：文案在**后端 goal 文本**里（不在前端），已改；上一轮的撤回作废

## C. M2：数据与口径

1. [x] **事项状态派生**：owner 感知；最新尝试覆盖历史 `passed`；`in_progress` 与 12 completed 并存要能解释
2. [x] **事项完成/取消 UI**（验收证据引用仍随 E 的北极星口径一起做）
3. [ ] **纯问答不自动建事项**
4. [x] 搜索命中片段（围绕命中词开窗；同会话合并仍未做）
5. [x] Activity 计数口径说明（该成员跨房间最近 50 次）
6. [x] run 详情 `Dispatched units` 关联语义**已核实正确**（`parent_run_id = 本 run`，实测 1 条且父 ID 匹配）——审计该条在当前代码不复现
7. [ ] 状态词与形状按对象归并（执行生命周期 / 连接 / 安装校验 三轴）

## D. 安全与决策（需 ADR）

1. [~] 代答硬拒绝：**不可逆已用字段实现**（`risk.irreversible` + `answerRefusal`）；超冻结授权 / 验收语义仍待 ADR
2. [x] 唤醒失败把 owner 转人（`escalateActionToUser` + 测试）
3. [x] `agent_create` 改为**只提案**（填创建页表单，人按 Create）；直建只留在 HTTP 路由
4. [ ] 验收证据与 `requirement` 状态绑定
5. [ ] Policy 版本化与在途通知

## E. 内存与长时验证

1. [ ] 无扩展固定路线 30 分钟 / 2 小时 retainer 采样（AHP 修复前后各一轮）
2. [ ] AHP 帧队列背压与每动作重映射成本度量
3. [ ] Query signal 透传；自写 tick 单在途 + abort

---

## 验收纪律

- 每条修复指到**可运行的测试或探针**；没有测试的文案改动不算修复完成。
- 部署后抽验：`/today`、`/system/settings`、一次执行详情、一次导出。
- 审计的旧结论按现状复核后再动：本轮撤回"refine here"；确认"ECharts"实为 Recharts。

## 7. 剩余项的选项（决策已收窄，不是没想）

| 项 | 选项 A | 选项 B | 现状与建议 |
|---|---|---|---|
| 交付固定 base/head Diff 深链 | 在 `agent_run.terminal_result` 里加 `delivery:{projectId,base,head}`，交付文本渲染成链接 | 从 worker 的最终文本里正则抽 SHA（脆弱，拒绝） | 选 A；改动面：run 终态写入 + 交付文案渲染 + Project Diff 接受 base/head 参数 |
| 纯问答不建事项 | 前台 run（role=front）在项目房间免 checkout，只有 worker 才开需求 | 需求改为"首次写入时创建" | 选 A：与已有"只有 worker 拿 checkout"一致；但要改 `resolveRunWorkspace` 的硬约束（项目房间必须有需求工作区），属 ADR 0077 修订 |
| 状态词与形状三轴归并 | 先统一"同对象同词 + 词形冗余（✓/×/Ⅱ/○）"，token 后置 | 一次性重做配色体系 | 选 A；审计自己也把配色列为待实测 |
| 代答：不可逆/超冻结/验收硬拒绝 | 让 `pending_action` 携带风险字段（`risk:{irreversible,scope}`），代答链按字段拒绝 | 按工具名黑名单判断 | 选 A：黑名单会变成假检查。需要 ACP 审批请求 → pending_action 的映射加字段 |
| agent_create 角色/人授权 | 创建前要求 `authorization` 含人的批准记录（dispatch 冻结里带上） | 直接创建改为只产出提案（`agent_write` 已有） | 选 B 更小：删掉生产路径的直建，保留提案；代价是 PA 招聘多一步人的 Save |
| 验收证据绑定 | 人点"完成"时把当前 run/artifact 引用写进 requirement | 规则化自动验收 | 只做 A；自动验收需要人预先定义规则（审计明确反对自报完成） |
| Policy 版本化 | 每次派单冻结 `configRevision` 的真实版本号（现在恒为 1） | 引入完整 Policy 对象 | 先做 A（当前恒 1 是假版本号），完整 Policy 等真实需求 |

## 8. 平台操作交给 PA（2026-11-24 追加）

- MCP：`project_detail`（读，预同意）、`project_attach`（写，需批准）；`project_list` / `team_list` / `requirement_query` 已有。
- 需求成为可**召回**的工作：`requirement` 进入统一召回（与 memory 同一条路），避免重复开项。
- 自动开需求只发生在 **worker** 的 run（前台问答不再留垃圾行）。
- Skills 统一 `<domain>_<action>`：`skills_about` / `agent_doctor` / `workflow_design` / `agent_fanout` / `project_manage` / `member_manage` / `requirement_memory`。
- builtin 包修复：目标目录缺失会重装并写 `installedRef`（线上 `ok=true, skills=7`）。

## 9. 本轮补充

- 代答更正时**保留原答者**：`answer_corrected` ops 事件记录 `originalAnsweredBy` 与 `originalEvidence`（否则更正后行里只剩 `user`，G2 的分母丢失）。没有专门的单测，靠 tsc + 人工核对事件写入点。
