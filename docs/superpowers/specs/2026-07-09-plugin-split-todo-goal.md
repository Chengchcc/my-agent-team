# Spec: Plugin 拆分 -- plugin-todo + plugin-goal

> 状态：待评审
> 关联：设计哲学"边界要硬，概念要少"

## 1. 目标

把现有的 `plugin-task-guard`（331行，无调用方）拆分为两个职责清晰的 plugin：
- `plugin-todo` -- todo 工具 + 进度注入（Agent 自主管理任务进度）
- `plugin-goal` -- error gate + goal 条件评估（保障 Agent 不该停时不停）

同时砍掉 task-guard 的过度设计（AI 预生成计划、全 done 才能停）。

## 2. plugin-todo

### 2.1 职责

让 Agent 通过 `todo_write` 工具管理任务进度，并把进度注入 system prompt。

### 2.2 内容

从 task-guard 提取：
- `Todo` / `TodoStatus` 类型
- `todo_write` 工具（Agent 标记进度）
- `renderTodo` 辅助函数
- `beforeModel` hook：注入 todo 进度到 system prompt
- `todo_update` 事件发射（前端 TodoPanel 消费）

### 2.3 接口

```typescript
export interface TodoPluginOptions {
  /** Inject todo progress into system prompt each turn. Default true. */
  showProgress?: boolean;
}

export function todoPlugin(opts?: TodoPluginOptions): Plugin;
```

### 2.4 不做的

- 不做 AI 预生成计划（generatePlan 删除）
- 不做 beforeRun hook
- 不做 stop 检查

## 3. plugin-goal

### 3.1 职责

保障 Agent 不该停时不停：
1. 确定性检查：unresolved tool errors
2. LLM 评估：goal 条件是否满足（可选）
3. 扩展验证器：extraValidators

### 3.2 内容

从 task-guard 提取 + 新增：
- `unresolvedToolErrors` 确定性验证器（保留）
- `extraValidators` 扩展点（保留）
- `StopValidator` 类型（保留）
- `beforeStop` hook：确定性检查 -> goal 评估
- **新增：goalCondition + evaluatorModel**

### 3.3 接口

```typescript
export interface GoalPluginOptions {
  /** Goal completion condition. If set, LLM evaluator runs after deterministic checks pass. */
  goalCondition?: string;
  /** Model for goal evaluation (default: use main model). */
  evaluatorModel?: ChatModel;
  /** Extra deterministic stop validators. */
  extraValidators?: StopValidator[];
}

export function goalPlugin(opts?: GoalPluginOptions): Plugin;
```

### 3.4 beforeStop 流程

```
Agent 准备停止
  ↓
Step 1: 确定性检查（免费、快）
  - unresolvedToolErrors -> 有未解决 error? 返回 { continue: true, reason }
  - extraValidators -> 逐个检查
  ↓ 全通过
Step 2: goal 评估（可选，花 token）
  - goalCondition 不存在? 返回 undefined（允许停）
  - goalCondition 存在:
    a. 用 evaluatorModel 读最近 N 轮对话，提取 structured output:
       { changed_files: string[], commands_run: string[], test_result: "pass"|"fail"|"unknown", summary: string }
    b. 把 structured output + goalCondition 交给评估器判断
    c. met=false -> 返回 { continue: true, reason: evaluatorFeedback }
    d. met=true -> 返回 undefined（允许停，goal 达成）
```

### 3.5 structured output 提取

```typescript
async function extractStructuredSummary(
  model: ChatModel,
  messages: readonly Message[],
): Promise<WorkSummary> {
  const prompt = `Based on the recent conversation, extract a structured summary as JSON:
    {
      "changed_files": ["list of files modified"],
      "commands_run": ["list of bash commands executed"],
      "test_result": "pass" | "fail" | "unknown",
      "summary": "one-sentence summary of what was done"
    }`;
  // 只传最近 10 条消息（控制 token）
  const recent = messages.slice(-10);
  const result = await collectStream(model.stream(
    [...recent, { role: "user", text: prompt }],
    { tools: [] as const },
  ));
  // 解析 JSON
}
```

### 3.6 goal 评估

```typescript
async function evaluateGoal(
  model: ChatModel,
  summary: WorkSummary,
  condition: string,
): Promise<{ met: boolean; reason: string }> {
  const prompt = `You are a goal evaluator. Based on this work summary, determine if the goal condition is met.

    Work summary: ${JSON.stringify(summary)}

    Goal condition: ${condition}

    Reply with JSON: { "met": true/false, "reason": "short explanation" }`;
  // 解析 JSON
}
```

## 4. 删除 plugin-task-guard

- `packages/plugin-task-guard/` 整个目录删除
- `tsconfig.json` 移除 path 引用
- commitlint scope `plugin-task-guard` 改为 `plugin-todo` + `plugin-goal`

## 5. 不做的

- 不做 `/goal` slash command（那是前端 UI 层的事，plugin 只管 beforeStop 逻辑）
- 不做 goal 状态持久化（goal 是会话内状态，不写 DB）
- 不做 goal 进度展示（前端可从 force_continue 事件推断）
- 不做 plan 生成（已删）
- 不做 todo 全 done 检查（已删）

## 6. 验收标准

1. `packages/plugin-todo/` 存在，导出 `todoPlugin` + `Todo` 类型
2. `packages/plugin-goal/` 存在，导出 `goalPlugin` + `StopValidator` 类型
3. `packages/plugin-task-guard/` 已删除
4. `tsconfig.json` 更新 path 引用
5. commitlint scope 更新
6. plugin-todo 测试通过（todo_write 工具 + 进度注入）
7. plugin-goal 测试通过（error gate + extraValidators）
8. typecheck + lint 全绿
