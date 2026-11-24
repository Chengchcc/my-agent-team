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

## B. 下一批（M1：派活与收货）

1. [ ] **执行单元折叠块**：一行显示目标、作者、改动文件数、最新交付、检查/互审深链；缺证据明示（前端 + 后端投影）
2. [ ] **交付固定 base/head Diff 深链**：复用 Project Diff，明确"历史交付 ≠ 当前副本"
3. [ ] **交付黄条**：写明判据有限（`delivery-gate` 只判"另一成员完成且未改"），可回查 revision
4. [ ] **Chat 索引页**空态引导（选择或新建）——已有描述与加载行，待补空态
5. [x] 需求详情「refine here」虚构承诺：当前源码无此文案，按现状撤销

## C. M2：数据与口径

1. [ ] **事项状态派生**：owner 感知；最新尝试覆盖历史 `passed`；`in_progress` 与 12 completed 并存要能解释
2. [ ] **事项完成/取消 UI + 验收证据引用**（北极星口径的基础）
3. [ ] **纯问答不自动建事项**
4. [ ] 搜索：命中片段 + 同会话合并
5. [ ] Activity 计数口径说明（仅所属会话 / 窗口）
6. [ ] run 详情 `Dispatched units` 关联语义校验或改名
7. [ ] 状态词与形状按对象归并（执行生命周期 / 连接 / 安装校验 三轴）

## D. 安全与决策（需 ADR）

1. [ ] 代答硬拒绝：不可逆、超冻结授权、验收语义（现在只有空证据拒绝）
2. [ ] 唤醒失败把 owner 转人（现在只写日志）
3. [ ] `agent_create` 服务内角色/人授权绑定，或改为只提案（当前护栏=不预同意 + 外层审批）
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
