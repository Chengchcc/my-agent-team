# Self-Evolution Phase 3 — Quality Assurance & Feedback Loop

**Date**: 2026-05-07  |  **Status**: Draft  |  **Depends on**: Phase 1 trace system + Phase 2 background review

---

## 1. Motivation

Phase 2 produces auto-generated skills but has no quality feedback loop:
- Skills are written directly to `~/.my-agent/skills/auto/` with no user review
- No way to know if an auto-skill actually helps or hurts
- SkillLoader caches indefinitely; new skills require restart
- Review prompt templates were hand-written once and never improved

Phase 3 closes these gaps: approval, measurement, hot-reload, and prompt optimization.

---

## 2. Design Principles

- **Only auto skills are measured** — User-created skills (`skills/`) are trusted. Only `~/.my-agent/skills/auto/` skills are tracked for effectiveness.
- **Approval is incremental, not blocking** — Users are not forced to review. Skills remain active until explicitly deleted or metrics indicate a problem.
- **Effectiveness is correlation, not causation** — Low success rate is a signal to review, not an automated delete.
- **Hot-reload is transparent** — `SkillLoader` reloads on file changes; no user action needed.

---

## 3. Feature 1: Approval Queue

### 3.1 Interaction Model

**Notification card buttons** (extend existing `ReviewNotification`):

```
┌─────────────────────────────────────────────────┐
│ 🔧 Auto-review 完成                              │
│                                                  │
│ 创建了 skill: fix-bash-permission-errors          │
│ 描述: 处理 /tmp 下 bash 权限问题的标准流程         │
│                                                  │
│ [按 v 查看] [按 k 保留] [按 d 删除] [忽略]        │
└─────────────────────────────────────────────────┘
```

**`/review` slash command**: Lists all auto skills with their status (new / kept / deleted) and effectiveness metrics. Supports sub-commands:

```
/review list                  # 列出所有 auto skill，标注状态和效果分
/review view <skill-name>     # 查看 SKILL.md 内容
/review keep <skill-name>     # 批准保留
/review delete <skill-name>   # 删除
/review edit <skill-name>     # 用 text_editor 打开编辑
```

### 3.2 Skill Status

每个 auto skill 维护一个 `status.json` 在 skill 目录旁：

```
~/.my-agent/skills/auto/
  ├── fix-permissions/
  │   └── SKILL.md
  ├── fix-permissions.status.json   # { "status": "pending", "createdAt": ..., "sourceRunId": "..." }
  └── ...
```

Status 值：`pending` → `kept` / `deleted`

`/review list` 显示：

```
Auto skills:
  fix-permissions    pending   (created 2h ago)
  bash-tricks        kept      3/5 success rate
  grep-pitfalls      pending   (created 5m ago)
```

### 3.3 Auto-accept

`pending` 超过 48 小时的 skill 自动变为 `kept`（不做破坏性操作）。

---

## 4. Feature 2: Effectiveness Tracking

### 4.1 Data Collection

Phase 1 `TraceRun` 已经记录了每轮使用的 tool。Phase 3 扩展：记录该 run 使用的 skill 列表。

`TraceSummary` 新增字段：

```typescript
interface TraceSummary {
  // ... existing fields ...
  activatedSkills?: string[];  // auto skills present in this run's system prompt
}
```

`TraceAgentMiddleware.beforeAgentRun` 检查当前 system prompt 中注入了哪些 auto skill（从 `SkillMiddleware` 的 metadata 或 system prompt 内容中提取），写入 trace。

### 4.2 Skill Score

```
effectiveness(skill) = successful_runs / total_runs_with_skill

successful_runs = count of TraceRun where:
  - skill was in activatedSkills
  - summary.outcome === 'completed'

total_runs_with_skill = count of TraceRun where:
  - skill was in activatedSkills
```

存储为 `status.json` 的一部分：

```json
{
  "status": "kept",
  "createdAt": 1715040000000,
  "sourceRunId": "abc123",
  "stats": {
    "totalRuns": 5,
    "successfulRuns": 3,
    "successRate": 0.6
  }
}
```

### 4.3 Low-Score Warning

当 `successRate < 0.5` 且 `totalRuns >= 3` 时，TUI 在通知区显示警告：

```
⚠️ fix-permissions success rate: 40% (2/5). 建议 /review 检查。
```

不自动删除——只提醒用户手动评估。

---

## 5. Feature 3: Skill Hot-Reload

### 5.1 Design

Skills only change between agent runs (Review Agent completes in `setImmediate`).
No file watcher needed — check once in `beforeAgentRun`.

### 5.2 Implementation

`SkillLoader` 新增 `checkAutoSkills()` 方法：

```typescript
import { existsSync, statSync } from 'node:fs';

class SkillLoader {
  private lastAutoSkillsMtime = 0;

  /** Check if auto skills have changed since last check. Call in beforeAgentRun. */
  checkAutoSkills(): void {
    try {
      const autoDir = path.join(os.homedir(), '.my-agent', 'skills', 'auto');
      if (!existsSync(autoDir)) return;
      const mtime = statSync(autoDir).mtimeMs;
      if (mtime > this.lastAutoSkillsMtime) {
        this.lastAutoSkillsMtime = mtime;
        this.clearCache();
      }
    } catch {
      // directory doesn't exist — nothing to reload
    }
  }
}
```

### 5.3 Integration

`TraceAgentMiddleware.beforeAgentRun` 调用 `skillLoader.checkAutoSkills()` 一次。

无需 watcher、防抖、清理。零性能开销。

---

## 6. Feature 4: Review Prompt Optimization

### 6.1 Approach

复用 skill-creator 的 `description_optimizer` 能力。将 review prompt 模板当作一个 skill 的 `description`，优化其触发和产出质量。

### 6.2 Eval Set

创建 `tests/evolution/review-prompt-evals.json`：

```json
[
  {
    "query": "Analyze this trace: 3 errors in 2 turns, bash permission denied twice, grep ENOENT once. Should a skill be created?",
    "should_trigger": true,
    "expected_skill_name": "fix-bash-permissions"
  },
  {
    "query": "Analyze this trace: 1 error in 10 turns, a one-off typo in a bash command. Should a skill be created?",
    "should_trigger": false
  },
  {
    "query": "Analyze this trace: 8 turns, 0 errors, used grep → text_editor → bash to fix a config issue. Should a skill be created?",
    "should_trigger": true,
    "expected_skill_name": "config-fix-workflow"
  }
]
```

至少 20 个用例（10 should-trigger, 10 should-not-trigger）。

### 6.3 Optimization Loop

手动运行（不是自动触发）：

```bash
python skills/skill-creator/scripts/run_loop.py \
  --eval-set tests/evolution/review-prompt-evals.json \
  --skill-path src/evolution/prompt-templates.ts \
  --model claude-sonnet-4-6 \
  --max-iterations 5
```

优化 `buildReviewPrompt` 中的模板文本，目标是：
- 提高 signal 的触发准确率（该创建时不漏，不该创建时不误创）
- 降低虚警率（`Nothing to save` 的响应率）

### 6.4 Prompt Versioning

优化后的模板带版本号：

```typescript
// src/evolution/prompt-templates.ts
const PROMPT_VERSION = 'v2-optimized';
// Templates optimized with skill-creator eval loop on 2026-05-07
```

---

## 7. Configuration

```json
{
  "trace": {
    "review": {
      "enabled": true,
      "model": "claude-3-haiku-20240307",
      "maxTurns": 6,
      "tokenLimit": 30000,
      "timeoutMs": 60000,
      "outputDir": "~/.my-agent/skills/auto",
      "autoAcceptHours": 48,
      "lowScoreWarningThreshold": 0.5
    }
  }
}
```

新增配置项：
- `autoAcceptHours` — pending skill 自动接受时间（默认 48）
- `lowScoreWarningThreshold` — 效果分警告阈值（默认 0.5）

---

## 8. File Structure

```
New:
  src/cli/tui/commands/review-commands.ts   # /review slash command
  src/evolution/effectiveness-tracker.ts    # success rate computation + status.json

Modified:
  src/cli/tui/components/ReviewNotification.tsx      # add keep/delete buttons
  src/cli/tui/state/store.ts                         # skill status + stats state
  src/skills/loader.ts                               # watchAutoSkills() + unwatch()
  src/trace/types.ts                                 # activatedSkills in TraceSummary
  src/trace/trace-buffer.ts                          # compute + persist activatedSkills
  src/trace/agent-middleware.ts                      # detect activated auto skills
  src/evolution/types.ts                             # SkillStatus, SkillStats types
  src/evolution/index.ts                             # wire effectiveness tracking
  src/trace/agent-middleware.ts                      # call skillLoader.checkAutoSkills() in beforeAgentRun
  src/config/types.ts                                # new config fields

New test files:
  tests/evolution/effectiveness-tracker.test.ts
  tests/evolution/review-commands.test.ts
  tests/skills/check-auto-skills.test.ts
  tests/evolution/review-prompt-evals.json
```

---

## 9. Architecture Compliance (Constitution §A–I)

- **§A**: No direct instantiation in `bin/*`. All wiring via `createAgentRuntime()`.
- **§B**: No `any` types.
- **§C**: No new hooks. All features use existing hook points or TUI commands.
- **§D**: ToolDispatcher unchanged.
- **§E**: No new `syncTodoFromContext` calls.
- **§F**: All new types used. No dead code.
- **§G**: Each file < 400 lines.
- **§H**: All new public APIs have unit tests.
- **§I**: `debugLog` only.

---

## 10. Future (Phase 4)

- **Auto-rollback** — If a skill's success rate drops below threshold, automatically deactivate it
- **Skill cross-project transfer** — Auto-detect when a skill from one project applies to another
- **Collaborative skill refinement** — Multiple users' trace data contributes to a shared skill pool
