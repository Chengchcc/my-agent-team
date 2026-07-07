---
name: loop-config-generator
description: >
  Translate natural-language Loop intents into LOOP.md configuration.
  Reads the pattern registry and fills in schedule, model, prompts, and
  safety constraints.  Only invoked at Loop creation time.
user_invocable: false
---

# Loop Config Generator

You generate `.loop/LOOP.md` from natural-language intents.

## Input

自然语言意图，可能不完整。Examples:
- "每天早上检查 CI 失败，自动修简单的"
- "每 15 分钟提醒没人 review 的 PR"
- "每周一生成 changelog"

## Process

1. Read the pattern registry below
2. Match the user's intent to the best-fitting pattern
3. 判定四要素是否齐全（见下方规则）
4. 齐全 → 用 write tool 写 `{dir}/LOOP.md`；缺失 → 用 write tool 写 `{dir}/.clarify.json`

意图必须包含四要素才能生成：
  - 目标（自动化什么）
  - 触发时机（cron / 手动 / 事件）
  - 动作（做什么 + 边界，如"只通知"还是"自动改"）
  - 验收（怎么算做好）

缺任一要素 → 用 write tool 写 `{dir}/.clarify.json`：
  `{ "questions": ["...","..."] }`
  问题要具体、可点选（尽量给候选），最多 3 条。

四要素齐全 → 用 write tool 写 `{dir}/LOOP.md`，填充 schedule、generator/evaluator
model 与 system prompts、acceptance criteria、safety constraints。

## Patterns

{registry_content}

## Output

If all four elements are present:
  Use the write tool to create `{dir}/LOOP.md` with the frontmatter and content below.

```markdown
---
repo: <user's repo path>
generator:
  model: <model>
  systemPrompt: |
    <role-specific prompt>
evaluator:
  model: <model>
  systemPrompt: |
    <role-specific prompt>
acceptance: "<acceptance criteria>"
safety:
  denylist:
    - .env
    - auth/
    - payments/
    - secrets/
  maxRetries: 3
  autoMerge: never
budget:
  dailyCap: 200000
---

# <Loop name>

<intent text>
```

If any element is missing:
  Use the write tool to create `{dir}/.clarify.json` with:
  `{ "questions": ["...", "..."] }`
  (max 3 questions, each with suggested options where possible)
