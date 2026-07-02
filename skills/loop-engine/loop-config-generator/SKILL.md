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

A single sentence describing what the user wants to automate. Examples:
- "每天早上检查 CI 失败，自动修简单的"
- "每 15 分钟提醒没人 review 的 PR"
- "每周一生成 changelog"

## Process

1. Read the pattern registry below
2. Match the user's intent to the best-fitting pattern
3. Fill in: schedule, generator/evaluator model and system prompts,
   acceptance criteria, safety constraints
4. Output the LOOP.md content

## Patterns

{registry_content}

## Output Format

Output the complete LOOP.md as a markdown code block, followed by
the matched pattern name on its own line:

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

pattern: <matched-pattern-name>
