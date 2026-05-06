# Self-Evolution System Design — Phase 2: Background Review

**Date**: 2026-05-06  |  **Status**: Draft  |  **Depends on**: Phase 1 trace system (`docs/superpowers/specs/2026-05-06-trace-system-design.md`)

---

## 1. Motivation

Phase 1 records agent execution into traces, detects patterns (error bursts, complex tasks, periodic intervals), and emits `NudgeResult` signals. But the signals are only logged — no action is taken.

Phase 2 closes the loop: when a NudgeResult fires, a lightweight background Review Agent analyzes the trace and produces structured, reusable skills. This enables self-evolution without polluting the project workspace.

---

## 2. Design Principles

- **Trace producer / Evolution consumer** — `src/trace/` records; `src/evolution/` acts. Trace module does not import from evolution.
- **Non-blocking** — Review Agent forks in `setImmediate`, never blocks TUI or the main agent loop.
- **Fail silent** — Review Agent errors are logged and discarded. The main conversation is never affected.
- **Only skills, not memory** — Review output is structured process knowledge (skills). Factual memory (user preferences, project conventions) remains the responsibility of the existing Memory system.
- **Dedup before write** — Before creating a skill, the Review Agent checks existing skills for title/content overlap.
- **User-safe output** — All output goes to `~/.my-agent/skills/auto/`. Project directories are never modified.

---

## 3. Architecture

### 3.1 Module Boundary

```
src/trace/                          src/evolution/
  (Phase 1, unchanged)                (Phase 2, new)
                                    
  agent-middleware.ts                 review-agent.ts        fork agent, build prompt
    └─ nudgeResult ──────────────►      └─ imports TraceStore, TraceRun, NudgeResult
                                    
  nudge-engine.ts                    review-tools.ts         create_review_skill tool
  store.ts                             └─ writes ~/.my-agent/skills/auto/
  types.ts                           prompt-templates.ts     per-trigger review prompts
                                     
                                     index.ts                initEvolution() factory
```

### 3.2 Data Flow

```
afterAgentRun (setImmediate)
  │
  ├─ store.finalize(trace)
  ├─ nudgeEngine.tick(trace) → NudgeResult | null
  │
  └─ if NudgeResult triggered:
       │
       ├─ 1. Retrieve context
       │     ├─ list existing skills/auto/ directories
       │     └─ query episodic memory for related patterns (dedup)
       │
       ├─ 2. Build review prompt
       │     ├─ select template by trigger type
       │     └─ inject: trace data + existing skills list + skill format spec
       │
       ├─ 3. Fork ReviewAgent (independent ContextManager)
       │     tools: [create_review_skill]
       │     model: configurable, default lightweight
       │     maxTurns: 6
       │
       └─ 4. On completion
             ├─ log result to debugLog
             └─ queue notification for user awareness (future UI)
```

### 3.3 Concurrency

- One Review Agent per session at a time.
- If a NudgeResult fires while a review is already running, the new signal is dropped (next signal will catch accumulated turns).
- Review Agent has independent token budget, does not consume main conversation context.

---

## 4. Review Prompt Templates

### 4.1 `error_burst` → `memory_review` or `combined_review`

```
You are reviewing a trace of an agent execution that had errors.

Trace summary:
- {totalTurns} turns, {totalErrors} errors
- Failed tools: {failedToolNames}

Full trace (turn-by-turn):
{trace}

Existing skills (do NOT duplicate):
{existingSkills}

Your task:
1. Score this pattern 1–5:
   - 1–2: one-off mistake or trivial — do NOT create a skill
   - 3–4: useful trick or pattern worth capturing
   - 5: high-value reusable workflow
2. If score < 3, respond "Nothing to save" and explain why
3. Identify the root cause of each tool error
4. Determine if this failure pattern is avoidable with a skill
5. If a skill already covers this, suggest adding a "Pitfalls" section
6. Only call create_review_skill if score ≥ 3 AND the pattern is reusable

Output: call create_review_skill ONLY if there is a concrete, reusable pattern.
```

### 4.2 `complex_task` → `skill_review`

```
You are reviewing a trace of a successful multi-step agent task.

Trace summary:
- {totalTurns} turns, 0 errors
- Tools used: {toolNames}

Full trace (turn-by-turn):
{trace}

Existing skills (do NOT duplicate):
{existingSkills}

Your task:
1. Score this workflow 1–5 for reusability:
   - 1–2: specific to this one task — do NOT create a skill
   - 3–4: recurring pattern for this project
   - 5: broadly reusable across contexts
2. If score < 3, respond "Nothing to save" and explain why
3. Identify the workflow — what was the sequence of steps?
4. Were there any non-obvious workarounds or tool-usage patterns?
5. If the workflow is reusable, create a skill capturing it
6. Include a "Pitfalls" section if any step could go wrong
7. Only call create_review_skill if score ≥ 3 AND the workflow is reusable

Output: call create_review_skill ONLY if there is a concrete, reusable workflow.
```

### 4.3 `periodic` → `skill_review`

```
Periodic review after {reviewInterval} accumulated turns across multiple runs.

Recent traces:
{recentTraceSummaries}

Existing skills:
{existingSkills}

Review these traces for patterns that should become skills.
If nothing actionable, respond "Nothing to save."
```

---

## 5. Review Agent

### 5.1 Fork

```typescript
function forkReviewAgent(
  nudgeResult: NudgeResult,
  trace: TraceRun,
  provider: Provider,
  config: ReviewConfig,
): void {
  const systemPrompt = buildReviewPrompt(nudgeResult, trace);

  const agent = new Agent({
    provider,  // configurable, default lightweight model
    contextManager: new ContextManager({
      tokenLimit: 30_000,
      defaultSystemPrompt: systemPrompt,
    }),
    toolRegistry: new ToolRegistry([
      new CreateReviewSkillTool(config.outputDir),
    ]),
    config: { tokenLimit: 30_000 },
    hooks: {},
    toolMiddlewares: [],
    maxTurns: config.maxTurns ?? 6,
  });

  agent.run({ userMessage: nudgeResult.reason })
    .then(() => debugLog('[evolution] Review completed'))
    .catch(err => debugLog(`[evolution] Review failed: ${err}`));
}
```

### 5.2 Constraints

| Dimension | Value |
|-----------|-------|
| Max turns | 6 |
| Token limit | 30,000 |
| Model | Configurable: `trace.review.model`, default `claude-3-haiku-20240307` |
| Timeout | 60 seconds (hard) |
| Tools | Only `create_review_skill` |
| Security | No bash, no file system access beyond `outputDir` |

---

## 6. `create_review_skill` Tool

### 6.1 Schema

```typescript
{
  name: 'create_review_skill',
  description: 'Create a new skill from reviewed trace patterns.',
  parameters: {
    skill_name: string,       // kebab-case, unique
    description: string,      // triggering description (when to use)
    body: string,             // markdown instructions
    pitfalls: string,         // optional: known failure modes
    scripts: Record<string, string>,  // optional: filename → content
    references: Record<string, string>, // optional: filename → content
  }
}
```

### 6.2 Write Path

```
~/.my-agent/skills/auto/{skill-name}/
  ├── SKILL.md
  ├── scripts/       (if any)
  ├── references/    (if any)
  └── _meta.json
```

### 6.3 SKILL.md Format

Follows the official skill format from `skill-creator`:

```markdown
---
name: {skill-name}
description: "{one-line description — include trigger contexts}"
---

# {Title}

{body}

## Pitfalls

{pitfalls}
```

### 6.4 Dedup Check

Before writing:

1. List all directories in `outputDir`
2. Check `skill_name` against existing names — if exact match, skip
3. Compute token-overlap between new `description` and existing skill descriptions — if > 80%, skip
4. Log skip reason to `debugLog`

### 6.5 Atomic Write

1. Create `outputDir/{skill-name}/` directory
2. Write `SKILL.md`
3. Write `_meta.json` with `{ slug, version: "1.0.0", publishedAt, source: "auto_review" }`
4. Write `scripts/` and `references/` files if provided
5. If any step fails, clean up the partially-created directory

---

## 7. Integration Point

### 7.1 `src/trace/agent-middleware.ts` — one-line change

```typescript
// Before (Phase 1):
if (nudgeResult) {
  debugLog(`[trace] Nudge triggered: ${nudgeResult.reason}`);
  await this.nudgeEngine.persist();
}

// After (Phase 2):
if (nudgeResult) {
  debugLog(`[trace] Nudge triggered: ${nudgeResult.reason}`);
  await this.nudgeEngine.persist();
  if (this.evolution?.review) {
    this.evolution.review(nudgeResult, trace);
  }
}
```

### 7.2 `src/runtime.ts` — wire evolution module

```typescript
import { initEvolution } from './evolution';

const evolution = traceEnabled
  ? initEvolution({ provider, settings: settings?.trace?.review })
  : undefined;

// Pass evolution to TraceAgentMiddleware constructor
```

---

## 8. TUI Notification

### 8.1 Passive Notification

Review Agent 完成后，TUI 在聊天流末尾插入一条系统通知，不阻塞用户：

```
┌─────────────────────────────────────────────────┐
│ 🔧 Auto-review 完成                              │
│                                                  │
│ 创建了 skill: fix-bash-permission-errors          │
│ 描述: 处理 /tmp 下 bash 权限问题的标准流程         │
│                                                  │
│ [按 v 查看] [按 d 删除] [忽略]                    │
└─────────────────────────────────────────────────┘
```

### 8.2 Behavior

| 用户操作 | 效果 |
|---------|------|
| 按 `v` 查看 | 用 Read 工具打开 SKILL.md 内容展示 |
| 按 `d` 删除 | 删除 `~/.my-agent/skills/auto/{skill-name}/` 目录 |
| 忽略 / 继续输入 | 通知保留在消息流中，可后续再处理 |
| 24h 后未处理 | 自动接受（保留 skill） |

### 8.3 Implementation

```
AgentEvent 新增类型:
  'evolution_review_done' → { skillName, description, outputDir }

TUI use-agent-loop.tsx:
  监听 evolution_review_done 事件 → dispatch 到 UI state
  → 渲染 ReviewNotification 组件（夹在消息流末尾）
```

### 8.4 通知堆积

同一 session 最多显示 3 条未处理通知。超过 3 条时，旧的自动折叠为：

```
🔧 Auto-review: 还有 2 条待处理 [展开]
```

---

## 9. Skill System Adaptation

### 9.1 Multi-Source Loading

现有 `SkillLoader` 只从单一 `basePath`（项目 `skills/` 目录）加载。需要支持多源：

```
项目 skills/          ~/.my-agent/skills/auto/       ~/.my-agent/skills/manual/
  (用户手动)              (auto-review 产出)            (用户全局安装)
```

### 9.2 SkillLoader 改动

```typescript
class SkillLoader {
  // 新增：多个源目录
  private sourcePaths: string[];

  constructor(basePath?: string) {
    const projectPath = basePath ?? path.resolve(cwd, settings.skills.baseDir);
    this.sourcePaths = [
      projectPath,                                          // 项目 skills/
      path.join(os.homedir(), '.my-agent', 'skills', 'auto'),    // auto-review
      path.join(os.homedir(), '.my-agent', 'skills', 'manual'),  // 用户全局
    ];
  }

  async listSkillNames(): Promise<string[]> {
    const allNames = new Set<string>();
    for (const dir of this.sourcePaths) {
      // 读取每个源目录的 skill 名
    }
    return [...allNames];
  }

  async loadSkill(name: string): Promise<SkillInfo | null> {
    // 按优先级查找：项目 > manual > auto
    // 项目 skill 覆盖同名 auto skill
    for (const dir of this.sourcePaths) {
      const skill = await this.tryLoad(dir, name);
      if (skill) return skill;
    }
    return null;
  }
}
```

### 9.3 优先级规则

| 场景 | 行为 |
|------|------|
| 同名 skill 在项目和 auto 都存在 | 项目版本生效，auto 版本被忽略 |
| auto + manual 同名 | manual 生效 |
| 只有 auto | auto 生效 |
| SkillLoader 缓存刷新 | 重新扫描所有源目录 |

### 9.4 SkillMiddleware 改动

无需改动。`SkillMiddleware` 通过 `SkillLoader.loadAllSkills()` 获取 skill 列表，对来源透明。

---

## 10. Configuration

```json
{
  "trace": {
    "review": {
      "enabled": true,
      "model": "claude-3-haiku-20240307",
      "maxTurns": 6,
      "tokenLimit": 30000,
      "timeoutMs": 60000,
      "outputDir": "~/.my-agent/skills/auto"
    }
  }
}
```

---

## 12. File Structure

```
src/evolution/
  ├── types.ts              # ReviewConfig, ReviewSession
  ├── review-agent.ts       # forkReviewAgent() — prompt assembly + agent fork
  ├── review-tools.ts       # CreateReviewSkillTool (ZodTool)
  ├── prompt-templates.ts   # buildReviewPrompt() — per-trigger templates
  └── index.ts              # initEvolution() factory

Modified:
  src/trace/agent-middleware.ts  # accept optional evolution callback
  src/trace/index.ts             # add evolution param to createTraceMiddleware
  src/runtime.ts                 # wire initEvolution
  src/skills/loader.ts           # multi-source skill loading
  src/config/types.ts            # add TraceReviewSettings
  src/config/defaults.ts         # add review defaults
  src/config/schema.ts           # add review schema
  src/cli/tui/                   # ReviewNotification component + event handling
```

---

## 13. Testing Strategy

```
tests/evolution/
  ├── review-tools.test.ts       # create_review_skill: write, dedup, atomic failure
  ├── prompt-templates.test.ts   # template rendering per trigger type
  ├── review-agent.test.ts       # fork + prompt injection + error handling
  └── dedup.test.ts              # name collision, description overlap > 80%
```

---

## 14. Architecture Compliance (Constitution §A–I)

- **§A**: Evolution wired via `createAgentRuntime()`, not in `bin/*`.
- **§B**: No `any` types.
- **§C**: No new hooks. Evolution is called from within existing `afterAgentRun`.
- **§D**: ToolDispatcher unchanged — Review Agent has its own ToolRegistry.
- **§E**: No new `syncTodoFromContext` calls.
- **§F**: All types used. No dead code.
- **§G**: Each file < 400 lines.
- **§H**: All new public APIs have unit tests.
- **§I**: `debugLog` only. No `console.log`, no `@ts-ignore`.

---

## 15. Future (Phase 3+)

- **User notification UI** — Surface review results in TUI
- **Approval queue** — Let user review/reject auto-generated skills before activation
- **Skill activation** — Auto-reload SkillLoader when new skills are written
- **Effectiveness tracking** — Track whether auto-generated skills actually reduce future errors
