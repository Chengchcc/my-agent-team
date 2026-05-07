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

### 4.1 Two-Tier Evaluation

```
Tier 1: Mechanical scoring (cheap, every run)
  success_rate = completed_runs / total_runs_with_skill

Tier 2: LLM deep review (triggered only when score looks bad)
  if success_rate < 0.5 AND total_runs >= 3:
    → fork a lightweight analysis agent
    → read all traces where this skill was active
    → judge: "skill is flawed" / "external factors" / "skill was irrelevant"
    → produce actionable recommendation
```

Why not pure mechanical:
- A good skill can be present during a failure caused by an unrelated API error
- A bad skill can be harmless noise that doesn't affect outcomes either way
- Correlation is not causation — LLM reads the actual trace to distinguish

### 4.2 Data Collection

`TraceSummary` 新增字段：

```typescript
interface TraceSummary {
  // ... existing fields ...
  activatedSkills?: string[];  // auto skills present in this run's system prompt
}
```

`TraceAgentMiddleware.beforeAgentRun` 从 system prompt 提取注入的 auto skill 名称，写入 trace。

### 4.3 Mechanical Scoring (Tier 1)

每次 `afterAgentRun` 中 store 持久化完成后，更新 `status.json`：

```json
{
  "status": "kept",
  "createdAt": 1715040000000,
  "sourceRunId": "abc123",
  "stats": {
    "totalRuns": 5,
    "successfulRuns": 3,
    "successRate": 0.6,
    "lastRunId": "xyz789"
  }
}
```

### 4.4 LLM Deep Review (Tier 2)

触发条件：`successRate < 0.5` 且 `totalRuns >= 3`

分析 Agent prompt：

```
You are evaluating the effectiveness of an auto-generated skill.

Skill: {skill_name}
Description: {description}
Success rate: {successRate} ({successfulRuns}/{totalRuns})

Related traces (runs where this skill was active):

Trace 1 (outcome: error):
{shortTrace1}

Trace 2 (outcome: completed):
{shortTrace2}

...

For each run where the outcome was "error", determine:
1. Was the skill's advice directly responsible for the error?
2. Was the error caused by external factors (API error, network, user interruption)?
3. Was the skill irrelevant to the task (present but unused)?

Overall assessment:
- "keep" — skill is useful, failures are unrelated
- "fix" — skill has specific issues (specify what to change)
- "delete" — skill is harmful or never useful

Output format: JSON with your verdict and reasoning.
```

分析结果写入 `status.json`：

```json
{
  "status": "reviewed",
  "stats": { ... },
  "lastReview": {
    "verdict": "fix",
    "reasoning": "The skill's chmod advice is correct but it doesn't mention that /tmp requires sudo on this system",
    "suggestion": "Add a Pitfalls entry about sudo requirements in system directories",
    "reviewedAt": 1715040000000
  }
}
```

### 4.5 TUI Notification

Tier 2 完成后在 TUI 通知：

```
⚠️ fix-permissions: 40% success rate (2/5)
   分析结果: skill 建议需调整 — "/tmp 下需要 sudo，skill 未说明"
   [/review 查看详情]
```

如果 verdict 是 "delete"，通知更强烈：

```
🚫 fix-permissions 被判定为有害 (40% 成功率)
   原因: {reasoning}
   [/review 删除] [保留]
```

不自动删除——最终决策留给用户。

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

## 6. Feature 4: Review Prompt Optimization (Feedback Loop)

### 6.1 Approach

复用 skill-creator 的 `description_optimizer` 能力。将 review prompt 模板当作一个 skill 的 `description`，优化其触发和产出质量。

### 6.2 Eval Set — Two Sources

**Source A: Hand-written seed cases** (`tests/evolution/review-prompt-evals.json`):

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
  }
]
```

At least 20 hand-written cases (10 should-trigger, 10 should-not-trigger).

**Source B: Auto-generated from Tier 2 analysis** (`tests/evolution/review-prompt-evals-feedback.json`):

When Tier 2 analysis produces a `verdict: "fix"`, the reasoning is automatically converted into an eval case:

```
Tier 2 output: "The skill doesn't mention that /tmp requires sudo"
→ New eval case: "Analyze this trace where bash in /tmp needed sudo but skill didn't mention it."
→ should_trigger: true
→ expected_behavior: "Skill includes permissions/sudo guidance"
```

This creates a feedback loop:

```
Review Prompt → Skill → Trace → Tier 2 Analysis → Feedback Eval → Prompt Optimization → Better Prompt → Better Skills
```

### 6.3 Optimization Loop

Combines both eval sources. Runs manually:

```bash
python skills/skill-creator/scripts/run_loop.py \
  --eval-set tests/evolution/review-prompt-evals.json \
  --extra-eval-set tests/evolution/review-prompt-evals-feedback.json \
  --skill-path src/evolution/prompt-templates.ts \
  --model claude-sonnet-4-6 \
  --max-iterations 5
```

Goals:
- Improve trigger accuracy (don't miss real patterns, don't create for one-offs)
- Reduce false positives (`Nothing to save` response rate)
- Incorporate real-world failure patterns from Tier 2 feedback

### 6.4 Feedback-Driven Prompt Evolution

```
After each Tier 2 analysis that returns "fix":
  1. Save the analysis result
  2. Convert to an eval case in review-prompt-evals-feedback.json
  3. Increment a counter "feedbackCasesPending"

When feedbackCasesPending >= 5:
  → TUI notification: "5 条新的 prompt 优化建议，建议运行 /review optimize"
  → User can run the optimization loop
```

用户主动触发，不自动改 prompt。

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
  src/evolution/effectiveness-tracker.ts    # mechanical scoring + LLM deep review trigger
  src/evolution/skill-analyzer.ts           # LLM analysis agent (Tier 2)

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
