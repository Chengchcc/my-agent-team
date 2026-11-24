# 独立审计处置（2026-11-24）

基线：`fd2c053a`（审计快照）+ 当日修复。审计原件在 `~/mat-independent-audit-20261124/`，
不进仓库；本文件只记**结论与证据位置**，不复制报告正文。

---

## 1. 已修（附可重跑证据）

| 缺陷 | 审计探针（修复前） | 现在 | 代码 / 测试 |
|---|---|---|---|
| AHP 取票期间关闭，晚回包仍建连且永不 shutdown | `connects=1, shutdowns=0` | 审计源版探针在 `connects` 处断言失败（0≠1） | `apps/web/src/lib/ahp.ts`（ticket await 与 initialize 后都查 `closed`）、`ahp.test.ts` |
| 有历史时新消息不乐观显示 | `overlay=0, newVisible=false` | 新消息立刻可见，echo 到达后合并不重复 | `conversation-reducer.ts`（`echoBaseline` 计数，替代"canonical 有真人消息"）、`conversation-reducer.test.ts` |
| Monaco JSON worker `Failed to parse URL` | 生产与 dev 双现 | `vs` 改为 `origin` 绝对 URL | `lib/monaco-loader.ts` |
| 会话空状态在历史到达前就说"发一条消息开始对话" | 现场 | `connecting` 期间显示"加载中" | `ConversationCanvas.tsx` |
| 指挥台数字在查询到达前报 0 | 现场 | 加载期显示 `—` | `app/(main)/today/page.tsx` |
| 侧栏会话列表加载期报"还没有会话" | 现场 | 加载期显示"加载中" | `NavRail.tsx` |

重跑审计探针（源码版，直接 import 当前仓库）：

```bash
cp ~/mat-independent-audit-20261124/frontend-evidence/source-probes.ts scripts/__audit-probe.ts
bun scripts/__audit-probe.ts   # 现在在第一个断言处失败：没有建连
rm scripts/__audit-probe.ts
```

## 2. 已证伪 / 已消解

- **"Fork 的 Run 前缀过滤丢回复"**：`fd2c053a` 之前的投影修复已经覆盖；探针第三个用例
  现在只剩 `answer kept`，`run:` 前缀行被排除。根因是"账本行没有 Run ⇒ 投影为空"，
  修在 `session-model.ts` 的 `buildTurns`，不在过滤规则。
- **"成员事件是空操作"**：`member` action 在 reducer 里声明但**没有任何派发方**。
  不是丢事件，是死代码；已删除该变体。
- **"Toaster 未挂载 / 三条死控件"**（前一轮报告）：本轮审计自身也复核为不成立。

## 3. 已修但属契约兑现（不是安全突破）

- **personal 不进 brief**（ADR 0074 四）：`wikiSvc.query` 增加 `excludeSections`，
  brief 出口传 `["personal"]`；测试钉在 `features/wiki/service.test.ts`。
  审计结论"仅标题与路径、非正文自动泄漏"与我们一致：这是上下文筛选契约，不是读权漏洞
  （`wiki_read` 本就对所有 agent 开放）。
- **agent 创建必须有人批准**：agent-config 是共享实例，路由层拿不到调用方身份，
  真正的护栏是"创建工具不在预同意清单里"。新增测试钉住
  `PRODUCT_CONSENTED_MCP_TOOLS` 不含任何 `mcp__agent-config__*`，防止将来被顺手加进去。

## 4. 待决策（不做"顺手改"，需要 ADR 取舍）

1. **代答的三类语义硬拒绝**（不可逆 / 超冻结授权 / 验收 / 无证据）：代答链目前只有
   "空证据拒绝"。加语义拒绝会改变派单与问询的产品语义，需要明确"谁有权代答什么"。
2. **agent 创建的服务内角色禁令**：需要把 run 身份（role + authorization）穿过
   MCP 桥到服务层，或把直接创建改成只产出提案。前者是协议改动，后者是产品取舍。
3. **内存**：2 小时 GB 级 renderer 在 10 轮隔离筛查中**未复现**。已加的 heap 哨兵只把
   "越用越卡"变成可见，不修越界保留。要定性需要 retainer 拆分（AHP 长历史 / 终端 /
   Monaco 共享 worker），不是一次构建能验的。
4. **UX 十项**（评分体系、配色、窄屏、读屏）：本轮先修可信度（"加载未到不报空/零"），
   视觉体系与战绩榜不动。

## 5. 口径

- 审计的构建版本与当前不同：`fd2c053a` → `cc8c70a7` 之后需重新采样才算常态 SLO。
- 审计没有执行生产写（审批、发送、创建、删除）。本文件也不把"只读复现"当"已修证明"，
  每条修复都指到一条可运行的测试或探针。

## 6. 第二轮（读完四份报告后的增量）

读完 `frontend-audit`／`product-audit`／`ux-audit`／`adr0074-evaluation` 后新增的处置：

| 项 | 处置 | 位置 |
|---|---|---|
| Fork 的 `run:<id>:assistant` 回复被丢 | **纠正上一轮的判断**：只跳错误气泡与本房已表示的 run；实测账本 811 条 assistant、679 条 tool 带该前缀 | `session-model.ts` + 探针 |
| AHP 每轮不释放 | 每轮 `finally` shutdown，重连不再留上一轮的 socket/subscription | `ahp.ts` + 测试 |
| 页面崩溃带走侧栏 | 新增 `(main)/error.tsx`（根边界在布局之上，旧注释不成立） | `app/(main)/error.tsx` |
| 终态仍写 STREAM ACTIVE | 徽章改为「实时跟随／已暂停」，终态即停 | `ExecutionTraceView`、`DagStatsBar` |
| 同一 run 列表 0s／详情 1m30s | 详情用真实 `terminalAt`；没有就显示「—」，不再编造 +90s | 同上 |
| Today 三条 `Finished: Coder` 撞题 | 后端 unread DTO 带房间标题；无标题才回退成员名 | `agent-run/http.ts`、`AttentionInbox` |
| Skills `Ready 1/1` 与目录缺失同屏 | 校验跑过后由校验结果单独决定 Ready 与卡片状态 | `team/skills/page.tsx` |
| 加载期假 0／假空 | 指挥台 KPI 显示 `—`；会话与侧栏显示加载中 | 已在前一轮 |
| 首屏不知道产品是干什么的 | Inbox 顶端一句「把目标告诉 Personal Agent…」 | `AttentionInbox` |

**撤回的旧结论**：需求详情的「refine goal here 却无入口」——当前源码里没有这句文案，按现状撤销。

**仍未做**（按 M1/M2/ADR 排期，见仓库 todo）：执行单元折叠块与固定 base/head Diff、交付黄条判据说明、事项状态派生与完成/取消 UI、纯问答不建事项、搜索命中片段、状态词按对象归并、代答三类硬拒绝、创建授权绑定、内存长测。
