# M5 Spec — LOOP.md 配置 + Loop API + Web UI

> **Status:** 🏗 Design → Implementation
> **Baseline:** M4（CronJob 集成 + fireLoop）完成态。
> **关联:** `apps/backend/src/features/loop/` · `apps/web/` · `skills/loop-engine/`

**Goal:** LOOP.md 替换硬编码 prompt、Loop CRUD API、Web 仪表盘与创建/详情页。MVP 收尾——`/issues` 从导航移除，`/loops` 成为工作面入口。

**Non-goals:**
- 不做手动触发（M5.1）
- 不做 review API（M5.1）
- 不做预算保护（M5.1）
- 不做 denylist 强制执行（M5.1）
- 不做 Issue 数据迁移
- 不做写锁

---

## 1. LOOP.md 格式

```markdown
---
repo: /home/projects/my-app
generator:
  model: claude-sonnet-4
  systemPrompt: |
    你是修 CI 的工程师。只改测试文件，不要重构无关代码。
    绝对不能 commit 或 push。
evaluator:
  model: claude-opus-4
  systemPrompt: |
    你是验证者。立场：假定修复是坏的，直到证明能跑。
    你要跑测试、检查 scope、对照验收标准。
acceptance: "被修改的测试文件相关测试全绿，改动范围合理"
safety:
  denylist:
    - .env
    - auth/
  maxRetries: 3
  autoMerge: never
budget:
  dailyCap: 200000
---

# Morning Triage

每天早上检查 CI 失败，自动修简单的。
```

**loopStep() 读 LOOP.md**：启动时读 frontmatter，取 `generator.model` / `evaluator.model` / `generator.systemPrompt` / `evaluator.systemPrompt` / `acceptance` / `repo`。如果 LOOP.md 不存在或解析失败 → fallback 到 M3 硬编码。

**只改 loopStep() 的 prompt 来源**，不改结构——模板插值不变。

## 2. 目录结构

```
<dataDir>/
  loops/                    ← M5 新增
    morning-triage/
      LOOP.md
      STATE.md
      INBOX.md
      skills/               ← 创建时从 skill-pack copy 的 runtime skills
```

`loop_config_path = "loops/morning-triage"`（相对路径）。`cwd = LOOP.md.repo`。

## 3. Skill Pack

```
skills/loop-engine/         ← 源代码目录
  loop-config-generator/SKILL.md
  loop-triage/SKILL.md
  loop-generator/SKILL.md
  loop-verifier/SKILL.md
  registry.yaml             ← 7 种 pattern
```

`seedSkillPacks` copy 到 `<dataDir>/skill-packs/loop-engine/`。progressive-skill 自动加载为 skill root。

**创建 Loop 时**：backend 起 AgentSession，系统 prompt 含 `registry.yaml` + 7 种 pattern 描述，输入用户 intent，输出 LOOP.md 内容 + 匹配的 pattern 名。backend 解析输出 → 写 LOOP.md + cron_job 行。

## 4. LOOP.md 解析

复用 `state-md.ts` 的 `parseYamlBlock`——只读 frontmatter。

```typescript
// packages/loop/src/state-md.ts 新增
export function parseLoopConfig(md: string): LoopConfig | null
```

返回 type：

```typescript
interface LoopConfig {
  repo: string;
  generator: { model: string; systemPrompt: string };
  evaluator: { model: string; systemPrompt: string };
  acceptance: string;
}
```

## 5. API

```
POST   /api/loops
  输入: { intent: string }
  输出: { loop: { id, name, cronExpr, loopConfigPath, preview } }
  内部: 起 AgentSession(loop-config-generator) → 生成 LOOP.md → 写文件 → 写 cron_job 行 → scheduler.register

GET    /api/loops
  = GET /api/cron-jobs?kind=loop 的别名

GET    /api/loops/:id
  输出: { loop: { id, name, cronExpr, enabled, lastRun, pendingCount } }
  内部: 读 cron_job 行 + parseStateMd(STATE.md) 取 lastRun + pending count

DELETE /api/loops/:id
  内部: 删 cron_job 行 + rm -rf loops/<name>/ + scheduler.unregister
```

## 6. Web UI

| 页面 | 路由 | 内容 |
|---|---|---|
| Loop 仪表盘 | `/loops` | 卡片列表：name、一行描述、pending badge、上次运行、[Pause] [View] |
| 创建 Loop | `/loops/new` | 输入框（自然语言 intent）→ 预览（LOOP.md + cron + model）→ 确认 |
| Loop 详情 | `/loops/:id` | Review queue（awaiting_review item 列表）+ 运行历史时间线 |

导航变更：`/issues` → 移除；`/loops` → 新加。

## 7. 验收标准

### LOOP.md

1. **parseLoopConfig 解析完整 LOOP.md**：repo, generator, evaluator, acceptance 正确
2. **LOOP.md 不存在 → fallback 硬编码**：loopStep 不报错
3. **loopStep 读 LOOP.md model**：generator/evaluator 使用 LOOP.md 的 model 而非硬编码

### Skill Pack

4. **skills/loop-engine/ 目录存在**：含 4 个 SKILL.md + registry.yaml
5. **seedSkillPacks 复制到 dataDir**：启动后 skill-packs/loop-engine/ 存在

### API

6. **POST /api/loops**：创建 LOOP.md + cron_job 行 + scheduler 注册
7. **GET /api/loops**：返回所有 loop（loopConfigPath IS NOT NULL）
8. **GET /api/loops/:id**：返回详情含 lastRun + pendingCount
9. **DELETE /api/loops/:id**：删行 + 删目录

### Web

10. **`/loops` 页面**：卡片列表，含 pending count badge
11. **`/loops/new` 页面**：intent 输入 → 预览 → 确认
12. **`/loops/:id` 页面**：review queue + 运行历史
13. **`/issues` 从导航移除**
14. **全 workspace typecheck + lint + test 通过**

## 8. 实施分组

| Patch | 内容 |
|---|---|
| P1 | `parseLoopConfig` —— packages/loop/src/state-md.ts |
| P2 | `skills/loop-engine/` —— 4 个 SKILL.md + registry.yaml |
| P3 | `seedSkillPacks` 注册 loop-engine pack |
| P4 | `loopStep` 读 LOOP.md 替换硬编码 |
| P5 | `/api/loops` CRUD routes |
| P6 | Web `/loops` 仪表盘 + `/loops/new` 创建页 + `/loops/:id` 详情 |
| P7 | 导航变更：`/issues` → `/loops` |
| P8 | 全 workspace 验证 |
