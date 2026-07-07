# Loop 创建向导 Spec — 让 /work/new 真正建出 Loop，而不是普通会话

> 状态：待评审
> 关联：ADR 0011（Web IA Work/Chat/Team）、`2026-07-02-loop-storage-isolation-convergence.md`（loop 状态/预算上 SQLite）
> 设计约束：`docs/architecture/design-philosophy.md` —— 统一本体、暴露业务、隐藏机制、边界要硬概念要少

---

## 0. 出发点：/work/new 是一个"假向导"

`apps/web/src/app/(main)/work/new/page.tsx` 在 mount 时调 `useCreateConversation`（→ `POST /api/conversations`），挂 `default` agent + 一个 human，然后渲染 `ConversationCanvas`。它**看起来**是"New Loop"，实际只建了一个普通会话。

由此产生 4 个事实缺陷：

```text
#1  没有调 POST /api/loops —— cron_job 行不存在、LOOP.md 不存在、scheduler 未注册，Loop 根本没被创建。
#2  会话挂的是 default agent，没有绑定 loop-config-generator skill；用户在画布里说什么都不会触发生成。
#3  没有"从对话提取 intent 再调创建 API"的任何机制。
#4  用户输入"你好"就是一次普通聊天，产物是一条 message，不是一个 Loop。
    → 现象验证：/work/new 走完后，Today 列表（GET /api/loops 按 loopConfigPath != null 过滤）里什么都没有。
```

同时后端 seed 只补了对话用的 `default` agent，**没有** Loop 运行期写死引用的 `loop-agent`（`main.ts:156-164` vs `http.ts:156`）。首次部署即缺记录。

**本 spec 的一句话目标**：

> `/work/new` 从"建会话"改为"建 Loop"，采用 **引导式向导 → 有界结构化澄清 → 预览确认后才启用（draft→activate）** 的动线；并补齐 `loop-agent` 的 seed。

---

## 1. 现状事实（代码锚点，避免臆断）

| 事实 | 位置 | 说明 |
|---|---|---|
| `/work/new` 只建会话 | `apps/web/src/app/(main)/work/new/page.tsx` | `useCreateConversation` on mount，无 loop 调用 |
| Loop 创建端点已存在且完整 | `apps/backend/src/features/loop/http.ts:146-273` | 建 cron_job → 建会话 → mkdir + 拷贝 skill 模板 → 有 intent 则跑 AgentSession 生成 LOOP.md → **register scheduler** → 返回 preview |
| 生成是单次、用完即弃 | `http.ts:220-222` | `session.prompt(intent)` 后立即 `sessionManager.dispose()`，session 不落库、不可续 → **今天不支持多轮澄清** |
| generator skill 按"单句→匹配 pattern→出 LOOP.md"设计 | `skills/loop-engine/loop-config-generator/SKILL.md` | 输入定义为 "A single sentence"，`user_invocable: false`，无"信息不足则反问"行为 |
| 契约不一致 | SKILL.md 要求"输出 markdown 代码块" vs `http.ts:216` intent prompt 要求"用 write tool 写 LOOP.md" | 两种产出契约，端点无法稳定解析生成结果 |
| **建即启用** | `http.ts:160` `enabled:true` + `http.ts:244` `scheduler.register(job)` | 用户还没看到 preview，Loop 已登记调度、随时触发 |
| 前端已有 useCreateLoop | `apps/web/src/features/loop/hooks.ts:20` / `apps/web/src/lib/api.ts:174` | `POST /api/loops`，body `{ name, intent?, projectId?, cronExpr? }` —— 已就绪，只是无人调用 |
| `/review` 是 item 级 | `http.ts:293-332` | body 是 `{ itemId, verdict }`，操作运行态 loop_item，**不可复用为创建期 activate** |
| setEnabled 已存在 | `apps/backend/src/features/cron/service.ts:149` | `setEnabled(id, bool)` → updateCronJob |
| scheduler 自动跳过 disabled | `apps/backend/src/features/cron/scheduler.ts:272` | `register(job)` 内 `if (!job.enabled) return` —— **draft 无需改调度逻辑** |

### 编号体系

- `F#` = 前端改动
- `B#` = 后端改动
- `S#` = seed 改动
- `K#` = skill 改动

---

## 2. 目标动线（UX）

```text
阶段 1  引导采集     模板卡（复用 registry pattern）+ 自由输入框，解决"不知道怎么用"
阶段 2  有界澄清     信息不足时 skill 返回 clarifying_questions，前端渲染成 chips/小表单，限 1–2 轮
阶段 3  预览确认     展示 LOOP.md preview（cron 翻译成人话）→ 确认启用 / 重新生成 / 手动编辑
```

**关键立场**：全程是"填空/点选"式向导，**不是自由聊天**。这既解决冷启动（#4 的"你好"问题源于开放式画布），又能逼出清晰意图，且不给系统引入多轮会话持久化这层机制（符合"概念要少"）。

---

## 3. B1 — Loop 创建改为 draft，不建即启用（修复 §1「建即启用」）

### 3.1 决策

`POST /api/loops` 创建时：

```text
createCronJob({ ..., enabled: false })   // 不再是 true
不调用 scheduler.register(job)            // 由后续 activate 触发
```

由于 `scheduler.register` 遇 `!job.enabled` 会自动 return（scheduler.ts:272），即使误注册也不会跑；但显式不注册更清晰。

### 3.2 新增激活端点

```text
POST /api/loops/:id/activate
  → cronSvc.setEnabled(id, true)          // service.ts:149 已存在
  → scheduler.register(cronSvc.getById(id))
  → 200 { loop: { id, enabled: true, cronExpr } }
```

- **不复用** `/review`（那是 item 级 verdict，语义完全不同——边界要硬）。
- 幂等：重复 activate 应安全（register 内部先 unregister 再注册）。
- 若 `cronExpr` 为空（用户只想手动触发的 Loop），activate 仅置 `enabled:true`，scheduler.register 对空表达式的既有行为保持不变（不新增定时器）。

### 3.3 draft 的可见性

Draft Loop（`enabled:false`）**仍应出现在 `GET /api/loops` 列表**（filter 只看 `loopConfigPath != null`），在 Today 里以 "Draft / 未启用" 状态标识，让用户能回到未完成的创建流。删除走既有 `DELETE /api/loops/:id`。

---

## 4. B2 — 生成结果结构化：generated | needs_clarification（修复 §1 契约不一致 + 支撑阶段 2）

### 4.1 决策：统一为"agent 用 write tool 写 LOOP.md"单一契约

放弃 SKILL.md 里的"输出 markdown 代码块"口径，统一到 `http.ts:216` 已有的"用 write tool 写 `${dir}/LOOP.md`"。理由：端点靠**读文件**判断产物，比解析对话文本稳定，且与 `update_loop_config` 工具的写副作用模型一致。K1 负责改 SKILL.md 对齐。

### 4.2 端点返回两态

```text
POST /api/loops  (intent 存在时，session.prompt 跑完后)

  若 LOOP.md 已生成（文件存在且非空模板）:
    201 { status: "generated",
          loop: { id, name, cronExpr, loopConfigPath, preview } }

  若 agent 判定信息不足（写出 clarify 产物而非 LOOP.md）:
    200 { status: "needs_clarification",
          loopId: <cronJobId>,          // draft 已建，占位
          questions: [ "...", "..." ] } // 结构化问题数组
```

**agent 如何表达"需要澄清"**：约定 agent 在信息不足时用 write tool 写 `${dir}/.clarify.json`（`{ questions: string[] }`）而非 `LOOP.md`。端点生成后先探 `.clarify.json`：存在 → `needs_clarification`；否则读 `LOOP.md` → `generated`。（保持"读文件判产物"的单一心智，不引入解析对话的旁路。）

### 4.3 澄清轮的重调：无状态重生成

用户答完问题后，前端把答案**拼进原 intent** 再调一次生成：

```text
POST /api/loops/:id/refine
  body: { intent: <原意图 + 澄清答案拼接> }
  → 复用同一 dir，删除旧 .clarify.json，重跑 session.prompt(refinedIntent)
  → 同样返回 generated | needs_clarification
```

- 选择"拼接重生成"而非"续 session"：现有 session 用完即弃、无持久化，续接需要给它补一整套 checkpoint/恢复机制，成本与"概念要少"相悖。无状态重调符合"单次生成"的既有心智。
- **限 1–2 轮**：第 2 轮 refine 后仍 `needs_clarification` 时，端点直接返回空模板 LOOP.md（`generated`）并附提示，让用户手动编辑，避免无限追问。

---

## 5. K1 — loop-config-generator skill 加"有界澄清"能力（修复 §1「skill 不会反问」）

### 5.1 SKILL.md 改动

1. 输入描述从 "A single sentence" 改为 "自然语言意图，可能不完整"。
2. 新增判定规则：

```text
意图必须包含四要素才能生成：
  - 目标（自动化什么）
  - 触发时机（cron / 手动 / 事件）
  - 动作（做什么 + 边界，如"只通知"还是"自动改"）
  - 验收（怎么算做好）

缺任一要素 → 用 write tool 写 {dir}/.clarify.json：{ "questions": ["...","..."] }
  问题要具体、可点选（尽量给候选），最多 3 条。
四要素齐全 → 用 write tool 写 {dir}/LOOP.md（不再输出 markdown 代码块）
```

3. 产出契约统一为"用 write tool 写文件"，删掉"Output the complete LOOP.md as a markdown code block"段。

### 5.2 skill pack 绑定

`POST /api/loops` 里 `buildConfig` 起的 AgentSession 必须能访问 `loop-config-generator`。当前 `http.ts:186-195` 已把 `loop-triage/loop-generator/loop-verifier` 拷进 `${dir}/skills`，但 **generator skill 是否在 session 的 skill 搜索路径内需核实**——若不在，需在 buildConfig 时把 `skills/loop-engine/loop-config-generator` 纳入。（实现期验证点，见 §8。）

---

## 6. F1 — /work/new 重写为三段式向导

### 6.1 移除

- 删掉 mount 时的 `useCreateConversation` 与 `ConversationCanvas`（`page.tsx` 全量重写）。

### 6.2 阶段 1 组件：意图采集

```text
<IntentStep>
  - 顶部引导语："描述你想自动化的事，我会帮你配好定时和步骤"
  - Pattern 卡片网格：从 registry 读 pattern 列表（如"每天修 CI 失败""PR 超时提醒""每周 changelog"）
      点卡 → 预填 intent 输入框
  - 自由输入 textarea（不匹配模板时用）
  - [下一步] → 调 useCreateLoop({ name: deriveName(intent), intent })
```

- `name` 不在这一步逼用户起；由 skill 从 intent derive 默认名，阶段 3 再让改。前端可先用 `intent.slice` 兜底占位。

### 6.3 阶段 2 组件：澄清（条件渲染）

```text
若返回 status === "needs_clarification":
  <ClarifyStep questions={...}>
    - 每个 question 渲染成 chips（若 skill 给了候选）或短输入
    - [继续] → 调 refine({ intent: 原意图 + 结构化答案 })
    - 计数器：第 2 轮后不再进入本步
```

### 6.4 阶段 3 组件：预览确认

```text
若返回 status === "generated":
  <PreviewStep loop={...}>
    - 渲染 LOOP.md preview
    - cron 表达式翻译成人话（"0 9 * * *" → "每天 09:00"）
    - 名称可编辑（确认或改名）
    - 三动作：
        [确认启用] → POST /api/loops/:id/activate → router.push(`/work/${id}`)
        [重新生成] → refine（清空重来）
        [手动编辑]  → 进详情页编辑 LOOP.md（复用现有 loop 详情编辑能力）
```

### 6.5 新增前端 hooks / api

- `api.activateLoop(id)` → `POST /api/loops/:id/activate`
- `api.refineLoop(id, { intent })` → `POST /api/loops/:id/refine`
- `useActivateLoop()` / `useRefineLoop()`（`features/loop/hooks.ts`）
- `useCreateLoop` 已存在，复用。

---

## 7. S1 — seed 补 loop-agent（修复 §0 seed 缺口）

### 7.1 现状

`main.ts:156-164` 只在 agent 表为空时 seed 一个 `id:"default"`。但 `POST /api/loops` 建 cron_job 时写死 `agentId:"loop-agent"`（`http.ts:156`），建会话 member 也用 `loop-agent`（`http.ts:175`）。首次部署缺 `loop-agent` 记录。

### 7.2 决策

seed 逻辑改为**分别确保两个 agent 存在**（不再用"表为空"作为唯一闸门，否则已有 default 的库永远补不上 loop-agent）：

```text
ensureAgent("default",    "Assistant",  claude-sonnet-4, permissionMode:"auto")
ensureAgent("loop-agent", "Loop Agent", claude-sonnet-4, permissionMode:"auto")
  ensureAgent(id, ...) = if (!agentSvc.getById(id)) agentSvc.create({...})
```

- 幂等：按 id 存在性判断，可安全重复启动。
- `loop-agent` 的 skill pack 绑定：`onAgentCreate` 已默认挂 `["builtin"]`（`main.ts:153`）；若 Loop 运行期需要额外 pack，在 S1 一并 `setAgentPacks("loop-agent", [...])`。（与 K1 §5.2 的 session skill 路径是两回事：前者是 agent 元数据，后者是创建期 session 的搜索 路径。）

---

## 8. 实现期验证点（写代码前必须先确认，避免返工）

1. **generator skill 是否在创建期 session 的搜索路径内**（§5.2）——若否，buildConfig 需显式纳入，否则 agent 拿不到 skill、生成退化为裸 prompt。
2. **`.clarify.json` / `LOOP.md` 探测顺序**在并发/重试下是否可能读到上一轮残留——refine 时必须先清理旧产物（§4.3 已含）。
3. **draft Loop 在 Today 列表的状态渲染**——`GET /api/loops` 是否已返回 `enabled` 字段（`http.ts:138` 返回了 `enabled: job.enabled`，前端据此显示 Draft 徽标）。
4. **loopStep/scheduler 对 `enabled:false` 的既有断言**——确认 draft 期间不会被任何后台路径误触发。

---

## 9. 验收标准

```text
AC1  /work/new 不再建普通会话；提交意图后库里出现 cron_job 行（enabled:false）+ loops/<name>/LOOP.md。
AC2  输入"你好"这类无效意图 → 返回 needs_clarification，前端展示澄清问题，不产生已启用 Loop。
AC3  意图完整（含四要素）→ 一次返回 generated + preview；未点"确认启用"前 scheduler 未注册该 job（不会触发）。
AC4  点"确认启用"后 GET /api/loops 该 Loop enabled:true 且出现在 Today 活跃列表；cron 到点能触发。
AC5  澄清最多 2 轮；第 2 轮后仍不足 → 落空模板 + 提示手动编辑，不无限追问。
AC6  全新库首启后，agentSvc 同时存在 default 与 loop-agent；已有 default 的旧库启动后被补上 loop-agent（幂等）。
AC7  SKILL.md 与端点产出契约一致（均为"write tool 写文件"）；不再存在"markdown 代码块 vs write tool"分叉。
AC8  typecheck / 各包单测保持全绿。
```

---

## 10. 后续项（本 spec 不做）

- 多轮真对话式创建（需给创建期 session 补持久化/恢复）——当前用无状态 refine 覆盖，暂不引入。
- Loop 模板市场 / 用户自定义 pattern 沉淀。
- `intent → name` 的智能命名优化（本 spec 用 skill derive + 用户可改即可）。
- 创建期 session 的可观测（trace）接入 —— 归入 System 面，不在本向导范围。

---

## 11. 变更清单速览

| 编号 | 文件 | 动作 |
|---|---|---|
| B1 | `apps/backend/src/features/loop/http.ts:146-273` | 创建改 `enabled:false` + 去掉 `scheduler.register` |
| B1 | `apps/backend/src/features/loop/http.ts` | 新增 `POST /api/loops/:id/activate` |
| B2 | `apps/backend/src/features/loop/http.ts` | 生成返回 `generated \| needs_clarification`；新增 `POST /api/loops/:id/refine` |
| K1 | `skills/loop-engine/loop-config-generator/SKILL.md` | 加四要素判定 + `.clarify.json` 产物 + 统一 write-tool 契约 |
| S1 | `apps/backend/src/main.ts:155-164` | 改 `ensureAgent`，补 `loop-agent`（幂等） |
| F1 | `apps/web/src/app/(main)/work/new/page.tsx` | 全量重写为三段式向导 |
| F1 | `apps/web/src/features/loop/hooks.ts` / `apps/web/src/lib/api.ts` | 加 `activateLoop` / `refineLoop` + hooks |
