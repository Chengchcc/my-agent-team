# M3 Spec — AgentSession 接线：loopStep() 起 generator + evaluator

> **Status:** 🏗 Design → Implementation
> **Baseline:** M2（STATE.md 读写 + 基础 loopStep）完成态。
> **关联:** `packages/loop/src/loop-reducer.ts` · `packages/loop/src/state-md.ts` · `packages/harness/src/`（AgentSession）

**Goal:** M2 的 TICK 后 item 停在 `fixing`——本 spec 把它接上真实 AgentSession：generator 改代码、evaluator 验证、verdict 经 reducer 推进 step。loopStep() 从 packages/loop 移到 `apps/backend`。

**Non-goals:**
- 不接 Discovery agent（延后到 M3.1 或 M4）
- 不加写锁、预算、CronJob 集成（M4）
- 不读 LOOP.md 配置（M3 用硬编码 prompt，M5 切配置）

---

## 1. 架构变更

```
packages/loop/src/          ← 纯逻辑，零 AgentSession 依赖
  types.ts
  loop-reducer.ts
  state-md.ts               (+ parseVerdictMd)
  index.ts
  (删除 loop-step.ts, loop-step.test.ts)

apps/backend/src/
  features/loop/
    loop-step.ts             ← M3: 读文件 → reducer → AgentSession → 写回
    loop-step.test.ts
```

## 2. loopStep() 签名

```typescript
interface SessionFactory {
  create(params: {
    sessionId: string;
    model: string;
    systemPrompt: string;
    cwd: string;
  }): Promise<{
    prompt(input: string): Promise<void>;
  }>;
  dispose(sessionId: string): Promise<void>;
}

function loopStep(params: {
  loopConfigPath: string;      // .loop/ 目录路径
  sessionFactory: SessionFactory;
  action?: ReviewAction;       // M2 复用的 human review action
}): Promise<LoopState>
```

## 3. TICK 流程（M3 扩展）

M2 的 TICK 只到 `fixing`。M3 在 TICK 后加了 3 步：

```
1. 读 STATE.md + INBOX.md → state（同 M2）

2. 如果有 action → reducer → 写回（同 M2）

3. 如果是 TICK（无 action）:
   a. reducer TICK → triaged → fixing
   b. 遍历每个 fixing item:
      i.   记录 baseSha = HEAD
      ii.  起 Generator AgentSession
      iii. 等 generator 跑完
      iv.  记录 filesChanged = git diff baseSha..HEAD
      v.   reducer GENERATOR_DONE → verifying
      vi.  拼 evaluator prompt（含 filesChanged + acceptance）
      vii. 起 Evaluator AgentSession
      viii.等 evaluator 跑完
      ix.  读 VERDICT.md → 解析 verdict
      x.   reducer EVALUATOR_VERDICT
      xi.  如果 REJECT: git reset --hard baseSha（回滚改动）
      xii. 如果 ESCALATE: git reset --hard baseSha
   c. 写回 STATE.md + INBOX.md（同 M2）

4. 返回新 state
```

TICK 只有一个 item——M3 先串行。并发（多个 fixing item 并行起 generator）延后到 M4。

## 4. prompt 模板（硬编码）

### Generator

```
你是一个修 bug 的工程师。只改相关文件，不要重构无关代码。
绝对不能 commit 或 push。

修改完成后，在本地 git commit，commit message 以 item id 开头。

当前任务:
- 问题: {item.summary}
- 来源: {item.source}
- 上次被拒原因: {item.result?.reasons}
```

### Evaluator

```
你是验证者。立场：假定修复是坏的，直到证明能跑。

你要做:
1. 跑项目测试（命令: bun test）
2. 用 git diff 确认只改了相关文件
3. 对照验收标准判断

验收标准: {acceptance}
Generator 改的文件: {filesChanged}

将判决写入 VERDICT.md，格式:
---
verdict: PASS|REJECT|ESCALATE
reasons: 原因（REJECT/ESCALATE 时必填，逗号分隔）
evidence: 你跑了什么、结果是什么
---
```

acceptance 硬编码为 `"被修改的文件相关测试全绿，改动范围合理"`。

## 5. 工作区隔离

- Generator 启动前：loopStep() 记 `baseSha = HEAD`
- Generator 干完：`filesChanged = git diff --name-only baseSha..HEAD`
- Evaluator REJECT/ESCALATE：loopStep() 执行 `git reset --hard baseSha`
- Evaluator PASS：commit 保留，等人 APPROVE

## 6. VERDICT.md 解析

`packages/loop/src/state-md.ts` 新增：

```typescript
function parseVerdictMd(md: string): Verdict | null
```

解析 `verdict: PASS|REJECT|ESCALATE` + `reasons:` + `evidence:` 从 markdown 文本。

返回 null 时 item 停在 `verifying`，不转移 step（与空 evidence 同策略）。

## 7. 验收标准

### state-md.ts 新增

1. **parseVerdictMd PASS**：正确解析 verdict + evidence
2. **parseVerdictMd REJECT**：正确解析 verdict + reasons + evidence
3. **parseVerdictMd ESCALATE**：正确解析
4. **格式不合法 → null**：找不到 `verdict:` 行 → null

### loopStep() M3

5. **TICK → Generator 被调用**：sessionFactory.create 被调用，model、prompt、cwd 正确
6. **Generator 完成后 → Evaluator 被调用**：不同 model，prompt 含 filesChanged
7. **Evaluator PASS → item.step = awaiting_review**：VERDICT.md 解析为 PASS
8. **Evaluator REJECT → item.step = fixing (attempt+1)**：代码回滚到 baseSha
9. **Evaluator REJECT 耗尽 → item.step = inbox**：代码回滚
10. **Evaluator ESCALATE → item.step = inbox**：代码回滚
11. **Evaluator 产出空 VERDICT.md → item 停在 verifying**
12. **Human action (APPROVE/REJECT_HUMAN/PROMOTE/RETRY/DISMISS) 不变**：M2 行为完整保留
13. **sessionFactory.dispose 对每个 sessionId 调用**
14. **全 workspace typecheck + lint + test 通过**

## 8. 实施分组

| Patch | 内容 | 文件 |
|---|---|---|
| P1 | parseVerdictMd + 测试 | `packages/loop/src/state-md.ts`, `state-md.test.ts` |
| P2 | 删除 packages/loop 中的 loop-step | `packages/loop/src/loop-step.ts`, `loop-step.test.ts`, `index.ts` |
| P3 | backend loop-step.ts | `apps/backend/src/features/loop/loop-step.ts` |
| P4 | backend loop-step.test.ts（mock SessionFactory） | `apps/backend/src/features/loop/loop-step.test.ts` |
| P5 | 全 workspace 验证 | — |

## 9. 风险

1. **硬编码 prompt → M5 替换**：M3 的 prompt 模板是占位。M5 落地 LOOP.md 后不改 loopStep() 结构——只把模板来源从常量换成 `parseYamlFrontmatter(LOOP.md)`。
2. **单 item 串行**：M3 只修一个 fixing item。多 item 并发等 M4（需要并发池 + 预算闸门）。
3. **VERDICT.md 是 evaluator 的唯一输出渠道**：如果 evaluator 不按要求写入文件，loopStep() 读不到 → item 停在 verifying。这跟 PRD 的"verdict 缺失 → 视为未裁决"一致。
