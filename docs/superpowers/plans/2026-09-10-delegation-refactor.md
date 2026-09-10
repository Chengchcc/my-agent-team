# delegation / orchestrate 重构执行计划（flash 模型机械执行版）

**日期**: 2026-09-10
**执行者**: flash 模型（低推理，按本计划逐条机械执行，不要即兴发挥）
**基线**: commit 当前 HEAD，`git status` 应为 clean
**目标**: 把 oma 的子代理派活（F1）与脚本编排（F2）从 "workflow" 命名中拆出来，按产品功能归档；事件全链路改名 `workflow_*` → `delegation_*`；删除 `run_workflow` 工具（task 吸收）；修 TUI 显示。

---

## 0. 铁律（每一步都要遵守）

1. **dist/ 目录永远不要手改**——全部由 `bun run build` 生成。
2. **不要动** `docs/superpowers/**` 旧计划/设计文档（历史档案）。
3. **保持不变清单**（全局替换时绝不能碰这些字符串）：
   - 存储目录 `.oma/workflow`（spill 结果、session dump、脚本落盘路径）
   - sessionId 模板前缀 `wf:`（`wf:${batchId}:${agentId}`）
   - 工具名 `workflow_run`、命令 `/workflow`、函数 `isValidWorkflowName`、`executeWorkflow`
   - 方法名 `runSubagent` / `listSubagents` / `getSubagentOutput` / `stopSubagent` / `abortAllSubagents`
   - TUI 文案 `workflow result:`（view-state applyOutcome，/workflow 产品结果行）
4. 每个 Step 结束后跑该 Step 的验证命令，红了就停下修，不要带病进下一步。
5. 提交信息：全英文、无 CJK、必须带 scope（用 `oh-my-agent` / `agent-contract` / `api-contract` / `adapter-oma-agent` / `backend` / `web` / `docs`）。

---

## Step 1 — 文件搬家（git mv，纯移动不改内容）

```bash
cd /root/my-agent-team
mkdir -p apps/oh-my-agent/src/core/delegation apps/oh-my-agent/src/core/orchestrate
git mv apps/oh-my-agent/src/core/workflow/workflow-executor.ts          apps/oh-my-agent/src/core/delegation/executor.ts
git mv apps/oh-my-agent/src/core/workflow/workflow-tools.ts             apps/oh-my-agent/src/core/delegation/tool.ts
git mv apps/oh-my-agent/src/core/workflow/subagent-registry.ts          apps/oh-my-agent/src/core/delegation/roles.ts
git mv apps/oh-my-agent/src/core/workflow/workflow-evaluator.ts         apps/oh-my-agent/src/core/orchestrate/script-runner.ts
git mv apps/oh-my-agent/src/core/workflow/workflow-executor.test.ts     apps/oh-my-agent/src/core/delegation/executor.test.ts
git mv apps/oh-my-agent/src/core/workflow/workflow-executor-subagent.test.ts apps/oh-my-agent/src/core/delegation/executor-subagent.test.ts
git mv apps/oh-my-agent/src/core/workflow/workflow-executor.fixture.ts  apps/oh-my-agent/src/core/delegation/executor.fixture.ts
git mv apps/oh-my-agent/src/core/workflow/subagent-registry.test.ts     apps/oh-my-agent/src/core/delegation/roles.test.ts
git mv apps/oh-my-agent/src/core/workflow/workflow-tools.test.ts        apps/oh-my-agent/src/core/delegation/tool.test.ts
git mv apps/oh-my-agent/src/core/workflow/workflow-evaluator.test.ts    apps/oh-my-agent/src/core/orchestrate/script-runner.test.ts
```

移动后 `apps/oh-my-agent/src/core/workflow/` 目录应为空并消失。

## Step 2 — delegation / orchestrate 内部改名（类型、函数、字段）

先做**事件名之外**的改名（事件名留到 Step 3），保证每步可测。

### 2a. `delegation/roles.ts`（原 subagent-registry.ts）

- `export interface SubagentRegistryEntry` → `export interface AgentRole`（定义 + 所有引用处，包括 `resolveAgent` 返回类型、`parseAgentDefinition` 返回类型、`SubagentRegistryEntry[]` 等）
- 文件内其它内容不动。

### 2b. `delegation/executor.ts`（原 workflow-executor.ts）

**全局字符串替换**（用 sd 或编辑器，注意顺序）：

| 旧 | 新 |
|---|---|
| `createWorkflowExecutor` | `createDelegationExecutor` |
| `WorkflowGateError` | `GateError` |
| `WorkflowAgentResult` | `SubagentResult` |
| `WorkflowAgentSpec` | `SubagentSpec` |
| `WorkflowRunResult` | `SubagentBatchResult` |
| `WorkflowExecutorOptions` | `DelegationExecutorOptions` |
| `interface WorkflowExecutor ` | `interface DelegationExecutor ` |
| `workflowId` | `batchId`（**全部**，含类型字段、参数、局部变量、emit 对象字段、safeName 调用、spillResults 调用） |
| `runWorkflow(` | `runBatch(` |

**替换后手工检查**（`grep -n batchId` + `grep -n workflow`）：
- `\`wf:${batchId}:${agentId}\`` 保留 `wf:` 前缀 ✓
- `.oma/workflow/${batchId}` 两处（session dump 路径 + spill 路径）保留 `.oma/workflow` 目录名 ✓
- 事件 type 字符串此刻仍是 `workflow_*`（Step 3 才改）✓

**事件 type 字符串现在不要动**。日志前缀 `[workflow]` → `[delegation]`（1 处 console.warn）。

### 2c. `delegation/tool.ts` + `orchestrate/tool.ts`（本步先改名，工具面收敛在 Step 4）

本步只做改名（Step 4 再删 run_workflow）：

- import 头改为：
  ```ts
  import type { PluginTool } from "../agent-runtime.js";
  import { builtinAgentNames, isValidWorkflowName, resolveAgent } from "./roles.js";
  import type { SubagentBatchResult, SubagentResult, SubagentSpec } from "./executor.js";
  export { isValidWorkflowName, parseAgentDefinition, type AgentRole } from "./roles.js";
  ```
- `export interface WorkflowScriptResult` → `export interface OrchestrationScriptResult`
- `export interface WorkflowToolDeps` → `export interface DelegationToolDeps`（字段类型 `WorkflowAgentSpec`/`WorkflowAgentResult`/`WorkflowRunResult` 相应换成 `SubagentSpec`/`SubagentResult`/`SubagentBatchResult`）
- `export function createWorkflowTools` → `export function createDelegationTools`
- 函数体内部类型引用同步改名。
- `workflow-evaluator.ts` 已不存在，`orchestrate/script-runner.ts` 里改名：
  - `WorkflowPrimitives` → `OrchestrationPrimitives`
  - `EvaluateResult` → `EvaluateResult`（保留）
  - `evaluateWorkflowScript` → `evaluateOrchestrationScript`

### 2d. `run-runtime.ts` 的 import 与局部变量改名（组装逻辑 Step 4 再改）

- 第 53-55 行 import 改为：
  ```ts
  import { evaluateOrchestrationScript } from "../orchestrate/script-runner.js";
  import { createDelegationExecutor, type SubagentResult } from "../delegation/executor.js";
  import { createDelegationTools, isValidWorkflowName } from "../delegation/tool.js";
  ```
- 局部变量改名（全局替换 run-runtime.ts 内）：
  - `workflowExecutor` → `delegationExecutor`
  - `workflowSpentTokens` → `delegationSpentTokens`
  - `workflowUsageAccum` → `delegationUsageAccum`
  - `workflowBudgetGate` → `delegationBudgetGate`
  - `fileTools` → `agentTools`（第 295-350 行区域，4 处；顺手把注释改成 "Shared native table: main loop + delegation subagents (no delegation/orchestrate/MCP tools for subagents)."）
  - `WorkflowAgentResult`（runScript 内 `const results: WorkflowAgentResult[]`）→ `SubagentResult`
- 接口 `RunRuntime` 里 `workflowUsage()` → `delegationUsage()`（注释同步改成 "Subagent usage accumulated across delegation_agent_completed events…"）

### 2e. 更新测试文件的 import 路径与工厂名（**只改 import/工厂名，不断言**）

- `delegation/executor.fixture.ts`：`createWorkflowExecutor` → `createDelegationExecutor`，`createWorkflowFixture` → `createDelegationFixture`（import 路径 `./executor.js` 不变）。
- `delegation/executor.test.ts` / `executor-subagent.test.ts`：
  - import fixture 路径不变（同目录）；`createWorkflowExecutor` → `createDelegationExecutor`，`createWorkflowFixture` → `createDelegationFixture`
  - `describe("createWorkflowExecutor"` → `describe("createDelegationExecutor"`
  - 所有 `workflowId:` 字段 → `batchId:`；`exec.runWorkflow(` → `exec.runBatch(`；`exec.runSubagent({ workflowId: ...` → `exec.runSubagent({ batchId: ...`
  - 注意：`workflow-executor.test.ts` 里对 `"echo:wf:wf1:a0"` 的断言**不要动**（sessionId 前缀 wf: 保留）。
- `delegation/roles.test.ts`：import `"./roles.js"`，断言不动。
- `delegation/tool.test.ts`：import `createDelegationTools` / `parseAgentDefinition` / `isValidWorkflowName` from `"./tool.js"`；`WorkflowAgentSpec` → `SubagentSpec`；工厂名同步。
- `orchestrate/script-runner.test.ts`：`evaluateWorkflowScript` → `evaluateOrchestrationScript`，import `"./script-runner.js"`。
- `run-runtime.ts` 引用更新后，检查还有没有文件 import `../workflow/`：`grep -rn "core/workflow" apps/oh-my-agent/src`（应只剩文档注释；dist 忽略）。

**验证 Step 2**（此时事件名还是 workflow_*，测试应该全绿）：
```bash
cd apps/oh-my-agent && bun test src/core/delegation src/core/orchestrate src/core/runtime/create-runtime.test.ts src/core/runtime/create-runtime-workflow.test.ts
```

---

## Step 3 — 事件全链路改名 workflow_* → delegation_*（六层同步，一个都不能漏）

映射关系（旧 → 新，字段 `workflowId` → `batchId`）：

| 旧事件 | 新事件 |
|---|---|
| `workflow_started` | `delegation_batch_started` |
| `workflow_agent_started` | `delegation_agent_started` |
| `workflow_agent_completed` | `delegation_agent_completed` |
| `workflow_completed` | `delegation_batch_completed` |
| `workflow_failed` | `delegation_batch_failed` |

### 3a. `apps/oh-my-agent/src/core/runtime/agent-event.ts`

第 57-75 行的 5 个 union 成员替换为：

```ts
  | { type: "delegation_batch_started"; batchId: string; label: string; agentCount: number }
  | { type: "delegation_agent_started"; batchId: string; agentId: string; label: string }
  | {
      type: "delegation_agent_completed";
      batchId: string;
      agentId: string;
      label: string;
      ok: boolean;
      error?: string;
      usage?: unknown;
    }
  | {
      type: "delegation_batch_completed";
      batchId: string;
      ok: boolean;
      agentCount: number;
      totalTokens: number;
    }
  | { type: "delegation_batch_failed"; batchId: string; error: string };
```

### 3b. `apps/oh-my-agent/src/core/delegation/executor.ts`（4 处 emit + 类型）

把 emit 对象里的 type 字符串替换（`"workflow_agent_started"` → `"delegation_agent_started"` 等 4 种；`workflow_failed` 在 runBatch catch 里）。字段名 `workflowId` 在 Step 2b 已改成 `batchId`，不用再动。

### 3c. `apps/oh-my-agent/src/core/runtime/run-runtime.ts`

- emit 监听：`event.type === "workflow_agent_completed"` → `event.type === "delegation_agent_completed"`
- runScript 里两个 `sessionEmit?.({ type: "workflow_started", workflowId, ... })` → `type: "delegation_batch_started", batchId, ...`；`"workflow_completed"` → `"delegation_batch_completed"`（字段 workflowId→batchId 已在 Step 2d 改名）。
- `runSubagent` mint 闭包里 `workflowId: \`sub-${crypto.randomUUID()}\`` → `batchId: \`sub-${crypto.randomUUID()}\``。
- 预算 gate 的 reason 文案 `"workflow budget exhausted"` → `"delegation budget exhausted"`。

### 3d. `apps/oh-my-agent/src/protocol/mapping.ts`（4 个 case）

第 62-95 行替换为：

```ts
    case "delegation_batch_started":
      return {
        type: "delegation_batch_started",
        batchId: String(event.data.batchId ?? ""),
        label: String(event.data.label ?? ""),
        agentCount: Number(event.data.agentCount ?? 0),
      };
    case "delegation_agent_started":
      return {
        type: "delegation_agent_started",
        batchId: String(event.data.batchId ?? ""),
        agentId: String(event.data.agentId ?? ""),
        label: String(event.data.label ?? ""),
      };
    case "delegation_agent_completed": {
      const usage = event.data.usage as Readonly<Record<string, unknown>> | undefined;
      return {
        type: "delegation_agent_completed",
        batchId: String(event.data.batchId ?? ""),
        agentId: String(event.data.agentId ?? ""),
        label: String(event.data.label ?? ""),
        ok: event.data.ok === true,
        ...(typeof event.data.error === "string" ? { error: event.data.error } : {}),
        ...(usage ? { usage } : {}),
      };
    }
    case "delegation_batch_completed":
      return {
        type: "delegation_batch_completed",
        batchId: String(event.data.batchId ?? ""),
        ok: event.data.ok === true,
        agentCount: Number(event.data.agentCount ?? 0),
        totalTokens: Number(event.data.totalTokens ?? 0),
      };
```

### 3e. `packages/adapter-oma-agent/src/event-mapper.ts`

与 3d **完全相同**的替换（该文件是同一份逻辑的副本，case 块逐字相同）。

### 3f. `packages/agent-contract/src/event.ts`

第 33-60 行的 4 个 union 成员替换为：

```ts
  | {
      readonly type: "delegation_batch_started";
      readonly batchId: string;
      readonly label: string;
      readonly agentCount: number;
    }
  | {
      readonly type: "delegation_agent_started";
      readonly batchId: string;
      readonly agentId: string;
      readonly label: string;
    }
  | {
      readonly type: "delegation_agent_completed";
      readonly batchId: string;
      readonly agentId: string;
      readonly label: string;
      readonly ok: boolean;
      readonly error?: string;
      readonly usage?: unknown;
    }
  | {
      readonly type: "delegation_batch_completed";
      readonly batchId: string;
      readonly ok: boolean;
      readonly agentCount: number;
      readonly totalTokens: number;
    };
```

### 3g. `packages/api-contract/src/sse.ts`（runEvents 里 5 个 key）

第 85-117 行替换为：

```ts
  delegation_batch_started: z.object({
    type: z.literal("delegation_batch_started"),
    batchId: z.string().optional(),
    label: z.string().optional(),
    agentCount: z.number().optional(),
  }),
  delegation_agent_started: z.object({
    type: z.literal("delegation_agent_started"),
    batchId: z.string().optional(),
    agentId: z.string().optional(),
    label: z.string().optional(),
  }),
  delegation_agent_completed: z.object({
    type: z.literal("delegation_agent_completed"),
    batchId: z.string().optional(),
    agentId: z.string().optional(),
    label: z.string().optional(),
    ok: z.boolean().optional(),
    error: z.string().optional(),
    usage: z.unknown().optional(),
  }),
  delegation_batch_completed: z.object({
    type: z.literal("delegation_batch_completed"),
    batchId: z.string().optional(),
    ok: z.boolean().optional(),
    agentCount: z.number().optional(),
    totalTokens: z.number().optional(),
  }),
  delegation_batch_failed: z.object({
    type: z.literal("delegation_batch_failed"),
    batchId: z.string().optional(),
    error: z.string().optional(),
  }),
```

### 3h. `apps/backend/src/features/agent-run/execution-input.ts`

`TELEMETRY_EVENT_TYPES` 里 4 行替换：`"workflow_started"` → `"delegation_batch_started"`、`"workflow_agent_started"` → `"delegation_agent_started"`、`"workflow_agent_completed"` → `"delegation_agent_completed"`、`"workflow_completed"` → `"delegation_batch_completed"`。

### 3i. `apps/web/src/hooks/useConversation.ts`

- 第 493 行 `const workflowId = String(ev.workflowId ?? "");` → `const batchId = String(ev.batchId ?? "");`，其下 `if (!workflowId) return;` → `if (!batchId) return;`，`upsertWorkflow(workflowId, ...)` → `upsertWorkflow(batchId, ...)`（共 3 处调用点）。
- JSON.parse 的类型注解里 `workflowId?: string;` → `batchId?: string;`
- 第 541-544 行：
  ```ts
  es.addEventListener("delegation_batch_started", workflowEvent("started"));
  es.addEventListener("delegation_agent_started", workflowEvent("agent_started"));
  es.addEventListener("delegation_agent_completed", workflowEvent("agent_completed"));
  es.addEventListener("delegation_batch_completed", workflowEvent("completed"));
  ```
  （函数名 `workflowEvent`/`upsertWorkflow`/状态类型 `WorkflowRunState` **保留不改**，它们指 web 的展示状态。）

### 3j. TUI 事件渲染 `apps/oh-my-agent/src/modes/tui/view-state.ts`

第 181-221 行替换为（**新增 agent_started 渲染**）：

```ts
    case "delegation_batch_started": {
      const run = ensureRunningRun(state);
      run.items.push({
        kind: "status",
        text: `delegating: ${event.label} (${event.agentCount} agents)`,
        streaming: false,
      });
      break;
    }
    case "delegation_agent_started": {
      const run = ensureRunningRun(state);
      run.items.push({
        kind: "status",
        text: `  \u25b6 ${event.label}`,
        streaming: false,
      });
      break;
    }
    case "delegation_agent_completed": {
      const run = ensureRunningRun(state);
      run.items.push({
        kind: "status",
        text: event.ok
          ? `  \u2714 ${event.label}`
          : `  \u2718 ${event.label}: ${event.error ?? "failed"}`,
        streaming: false,
      });
      break;
    }
    case "delegation_batch_completed": {
      const run = ensureRunningRun(state);
      run.items.push({
        kind: "status",
        text: `delegation done \u00b7 ${event.totalTokens} tokens`,
        streaming: false,
      });
      break;
    }
    case "queue_update": {
      if (event.drained?.length) settleSteeredMessages(state, event.drained);
      break;
    }
    case "delegation_batch_failed": {
      const run = ensureRunningRun(state);
      run.items.push({ kind: "error", text: `delegation: ${event.error}`, streaming: false });
      break;
    }
```

注意：`applyOutcome` 里的 `workflow result:` 文案**保留不动**。第 229 行注释 `// todo/queue/recap/workflow events` → `// todo/queue/recap/delegation events`。

### 3k. 更新所有断言事件名的测试

- `delegation/executor.test.ts`：`"workflow_agent_started"` → `"delegation_agent_started"`（2 处）、`"workflow_agent_completed"` → `"delegation_agent_completed"`（2 处）、`"workflow_started"` → `"delegation_batch_started"`（1 处）、`"workflow_completed"` → `"delegation_batch_completed"`（1 处）、`"workflow_failed"` → `"delegation_batch_failed"`（2 处）。
- `delegation/executor-subagent.test.ts`：`{ type: "workflow_agent_completed" }` → `{ type: "delegation_agent_completed" }`（1 处）。
- `src/core/runtime/create-runtime.test.ts` 第 355-358 行：4 个 `events` 断言 → `"delegation_batch_started"` / `"delegation_agent_started"` / `"delegation_agent_completed"` / `"delegation_batch_completed"`；第 419-420 行 → `"delegation_agent_completed"` / `"delegation_batch_completed"`。
- `src/modes/tui/tui-mode.test.ts` 第 111-145 行测试：事件 type 全部替换（`workflow_started` → `delegation_batch_started`，字段 `workflowId: "w"` → `batchId: "w"`，`workflow_agent_completed` → `delegation_agent_completed`，`workflow_completed` → `delegation_batch_completed`）；测试标题改 `"delegation events fold into transcript statuses"`。断言不用改（"audit (3 agents)"、"two: boom"、"123 tokens" 在新文案里都成立）。
- `src/modes/tui/tui-session.test.ts` 第 274-275 行：
  ```ts
  expect(statuses.some((t) => t.includes("delegating: script"))).toBe(true);
  expect(statuses.some((t) => t.includes("delegation done"))).toBe(true);
  ```
  第 276 行 `"workflow result: 42"` **保留**。

**验证 Step 3**：
```bash
cd apps/oh-my-agent && bun test src/core/delegation src/core/orchestrate src/core/runtime src/modes/tui/tui-mode.test.ts src/modes/tui/tui-session.test.ts
cd apps/oh-my-agent && bun run typecheck
cd packages/agent-contract && bun run build
cd packages/api-contract && bun run build
cd packages/adapter-oma-agent && bun run build
cd apps/backend && bun run typecheck
cd apps/web && bun run typecheck
```

---

## Step 4 — 工具面收敛（删 run_workflow，task 吸收 runBatch + spill + 批事件）

### 4a. 新建 `apps/oh-my-agent/src/core/orchestrate/tool.ts`（完整新文件）

```ts
import type { PluginTool } from "../agent-runtime.js";
import { isValidWorkflowName } from "../delegation/roles.js";

export interface OrchestrationScriptResult {
  readonly ok: boolean;
  readonly totalTokens: number;
  readonly value: unknown;
}

export interface OrchestrateToolDeps {
  /** Executes an orchestration script in the vm sandbox. */
  readonly runScript: (input: {
    script: string;
    args?: unknown;
  }) => Promise<OrchestrationScriptResult>;
  /** Persist a script to `<workspace>/.oma/workflow/<name>.js` for reuse. */
  readonly writeScript: (name: string, content: string) => void;
  /** Load a saved script by name (B8: `workflow_run({name})` re-runs a
   *  saved workflow without re-supplying the body). null = not found. */
  readonly readScript: (name: string) => Promise<string | null>;
}

export function createOrchestrateTool(deps: OrchestrateToolDeps): readonly PluginTool[] {
  const runScript: PluginTool = {
    name: "workflow_run",
    description:
      "Run an orchestration script (top-level-await JS) that fans out subagents " +
      "via agent(prompt, {schema?, label?}) and pipeline(items, fn). Scripts have " +
      "NO fs/network access - agents do the work. Save reusable scripts with the " +
      "name argument (written to .oma/workflow/<name>.js), then re-run one later " +
      "with ONLY the name argument (loads the saved script).",
    executionMode: "serial",
    inputSchema: {
      type: "object",
      properties: {
        // script XOR name: either a new body, or a saved workflow to re-run
        // (the runtime enforces the XOR — at least one must be present).
        script: { type: "string", maxLength: 32768 },
        name: { type: "string" },
        args: { type: "object" },
      },
    },
    async execute(args) {
      const rawScript = typeof args.script === "string" ? args.script : "";
      const name = typeof args.name === "string" && args.name.length > 0 ? args.name : null;
      if (name && !isValidWorkflowName(name)) {
        return { ok: false, error: `invalid workflow name (allowed: [a-z0-9-], max 64): ${name}` };
      }
      if (rawScript && name) deps.writeScript(name, rawScript);
      let script = rawScript;
      if (!script && name) {
        const saved = await deps.readScript(name);
        if (saved === null) {
          return { ok: false, error: `workflow "${name}" not found in .oma/workflow` };
        }
        script = saved;
      }
      if (!script) return { ok: false, error: "script or name is required" };
      const result = await deps.runScript({ script, args: args.args });
      return {
        ok: result.ok,
        totalTokens: result.totalTokens,
        value: result.value,
        scriptSaved: Boolean(rawScript && name),
      };
    },
  };
  return [runScript];
}
```

### 4b. 改造 `delegation/tool.ts`

1. 删除 `export interface WorkflowScriptResult`（整体迁到 orchestrate/tool.ts）。
2. `DelegationToolDeps` 接口替换为（删 runScript/writeScript/readScript，runWorkflow → runBatch）：

```ts
export interface DelegationBatchInput {
  readonly batchId: string;
  readonly label: string;
  readonly items: readonly SubagentSpec[];
  readonly signal?: AbortSignal;
}

export interface DelegationToolDeps {
  /** Fan out a pre-resolved item list under the executor's semaphore:
   *  emits delegation_batch_started/completed, spills long texts, aborts
   *  siblings on gate failure. */
  readonly runBatch: (input: DelegationBatchInput) => Promise<SubagentBatchResult>;
  /** 3.4: dispatch ONE named subagent (batchId/agentId are minted by the
   *  wiring closure). `signal` is the calling loop's abort signal. */
  readonly runSubagent: (
    spec: SubagentSpec,
    signal?: AbortSignal,
  ) => Promise<SubagentResult>;
  /** 3.4: raw markdown of `<workspace>/.oma/agents/<name>.md`, or null when
   *  absent. The name is already validated before this is called. */
  readonly readAgentDefinition: (name: string) => Promise<string | null>;
  /** 3.4 Phase 3 control plane. */
  readonly listSubagents: () => Array<{
    handle: string;
    label: string;
    status: string;
    usage?: unknown;
  }>;
  readonly getSubagentOutput: (handle: string) => {
    handle: string;
    status: string;
    result?: SubagentResult;
  };
  readonly stopSubagent: (handle: string) => { ok: boolean; error?: string };
}
```

3. 删除整个 `runWorkflow` PluginTool 块（从 `const runWorkflow: PluginTool = {` 到它的收尾 `};`，约第 78-118 行）和 `runScript` PluginTool 块（约第 120-163 行）。
4. 常量行改为 `const MAX_BATCH_TASKS = 64;`（删除 `BATCH_CONCURRENCY = 4` 行）。
5. task 工具 description 替换为：

```ts
      "Fan out subagents. BATCH (preferred): {context, tasks:[{name?, agent?, task, outputSchema?}]} — " +
      "context is shared background injected into every spawn; items run under the executor " +
      "semaphore; long results spill to .oma/workflow with a resultPath. Roles: task (full tools), " +
      "explore (read-only), plan (read-only planning), or any .oma/agents/<name>.md definition. " +
      "SINGLE (compat): {agent, prompt, schema?, background?, resume?} — background:true returns a " +
      "handle immediately (poll via task_output); {resume, prompt} continues the SAME subagent.",
```

6. task 的 batch 分支：从 `if (Array.isArray(args.tasks)) {` 到该分支结束（`results` worker 池 + `Promise.all(workers)` + 拼接 + return 的整段，约第 216-326 行）替换为：

```ts
      if (Array.isArray(args.tasks)) {
        const context = typeof args.context === "string" ? args.context.trim() : "";
        if (!context) {
          return {
            ok: false,
            error: "context is required for batch calls (shared background for every spawn)",
          };
        }
        const items = args.tasks as Array<Record<string, unknown>>;
        if (items.length === 0) return { ok: false, error: "tasks must be a non-empty array" };
        if (items.length > MAX_BATCH_TASKS) {
          return { ok: false, error: `too many tasks (${items.length}; max ${MAX_BATCH_TASKS})` };
        }
        const seen = new Set<string>();
        for (const item of items) {
          if (typeof item.task !== "string" || item.task.trim() === "") {
            return { ok: false, error: "each task item needs a non-empty task" };
          }
          if (typeof item.name === "string" && item.name.trim() !== "") {
            const key = item.name.trim().toLowerCase();
            if (seen.has(key)) {
              return { ok: false, error: `duplicate task name "${item.name.trim()}"` };
            }
            seen.add(key);
          }
        }
        // Resolve roles upfront: one unknown role fails the whole call
        // before any spawn (pi-aligned validation shape).
        const metas: Array<{
          label: string;
          agent: string;
          task: string;
          schema?: Readonly<Record<string, unknown>>;
          systemPrompt: string;
          tools?: readonly string[];
          modelId?: string;
        }> = [];
        for (const item of items) {
          const agent =
            typeof item.agent === "string" && item.agent.trim() !== "" ? item.agent.trim() : "task";
          const def = await resolveAgent(agent, deps.readAgentDefinition);
          if (!def) {
            return {
              ok: false,
              error: `unknown subagent "${agent}" (builtin: ${builtinAgentNames().join(", ")}; or .oma/agents/<name>.md)`,
            };
          }
          metas.push({
            label:
              typeof item.name === "string" && item.name.trim() !== ""
                ? item.name.trim()
                : `${agent}-${metas.length + 1}`,
            agent,
            task: item.task as string,
            schema:
              typeof item.outputSchema === "object" &&
              item.outputSchema !== null &&
              !Array.isArray(item.outputSchema)
                ? (item.outputSchema as Readonly<Record<string, unknown>>)
                : undefined,
            systemPrompt: def.systemPrompt,
            tools: def.tools,
            modelId: def.modelId,
          });
        }
        const batch = await deps.runBatch({
          batchId: `task-${crypto.randomUUID()}`,
          label: "task",
          items: metas.map((meta) => ({
            prompt: `${context}\n\n---\n\n${meta.task}`,
            label: meta.label,
            ...(meta.schema ? { schema: meta.schema } : {}),
            systemPrompt: meta.systemPrompt,
            ...(meta.tools ? { toolNames: meta.tools } : {}),
            ...(meta.modelId ? { modelId: meta.modelId } : {}),
          })),
          ...(signal ? { signal } : {}),
        });
        const results = batch.items.map((r, i) => ({
          index: i + 1,
          name: r.label,
          agent: metas[i]!.agent,
          ok: r.ok,
          text: r.text,
          ...(r.output !== undefined ? { output: r.output } : {}),
          ...(r.error ? { error: r.error } : {}),
          ...(r.usage ? { usage: r.usage } : {}),
          ...(r.handle ? { handle: r.handle } : {}),
          ...(r.resultPath ? { resultPath: r.resultPath } : {}),
        }));
        const lines = results.map(
          (r, i) =>
            `${i + 1}. ${r.name} (${r.agent}) — ${r.ok ? "ok" : "error"}\n${String(r.text ?? r.error ?? "")}`,
        );
        return { ok: batch.ok, content: lines.join("\n\n"), results };
      }
```

7. single 分支（prompt/resume/agent）原样保留。
8. 函数尾部 `return [runWorkflow, runScript, task, taskList, taskOutput, taskStop];` → `return [task, taskList, taskOutput, taskStop];`
9. 文件顶部 import 若有 `crypto` 缺失则加 `import { randomUUID as crypto } from "node:crypto";`——原文件 batch 分支用过 `crypto.randomUUID()`（runWorkflow 用），若删除后无引用点，按需保留。**检查**：新 batch 代码用了 `crypto.randomUUID()`，需要 import；原文件在 `runWorkflow` 工具里用了 `crypto.randomUUID()` 说明已有 import，保留即可。

### 4c. `run-runtime.ts` 组装替换

第 883-932 行 plugins.push 块替换为：

```ts
  plugins.push({
    name: "delegation-tools",
    tools: createDelegationTools({
      runBatch: (input) => delegationExecutor.runBatch(input),
      runSubagent: (spec, signal) =>
        delegationExecutor.runSubagent(
          {
            ...spec,
            batchId: `sub-${crypto.randomUUID()}`,
            agentId: spec.label ?? "sub",
          },
          signal,
        ),
      readAgentDefinition: async (name) => {
        if (!isValidWorkflowName(name)) return null;
        // read_only workspaces have no local agent definitions — builtins only.
        if (deps.workspaceAccess !== "read_write") return null;
        try {
          return await Bun.file(join(deps.workspaceRoot, ".oma", "agents", `${name}.md`)).text();
        } catch {
          return null;
        }
      },
      listSubagents: () => delegationExecutor.listSubagents(),
      getSubagentOutput: (handle) => delegationExecutor.getSubagentOutput(handle),
      stopSubagent: (handle) => delegationExecutor.stopSubagent(handle),
    }),
  });
  plugins.push({
    name: "orchestrate-tool",
    tools: createOrchestrateTool({
      runScript,
      writeScript: (name, content) => {
        // The name is model-supplied: never treat it as a path segment
        // (a "../" escape would write outside the workspace).
        if (!isValidWorkflowName(name)) {
          throw new Error(`invalid workflow name (allowed: [a-z0-9-], max 64): ${name}`);
        }
        if (deps.workspaceAccess !== "read_write") {
          throw new Error("workflow scripts cannot be saved in a read_only workspace");
        }
        const dir = join(deps.workspaceRoot, ".oma/workflow");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${name}.js`), content);
      },
      readScript: async (name) => {
        if (!isValidWorkflowName(name)) return null;
        try {
          return await Bun.file(join(deps.workspaceRoot, ".oma/workflow", `${name}.js`)).text();
        } catch {
          return null;
        }
      },
    }),
  });
```

新增 import：`import { createOrchestrateTool } from "../orchestrate/tool.js";`

### 4d. `delegation/tool.test.ts` 重写为 delegation 专用（完整替换文件内容）

```ts
import { describe, expect, test } from "bun:test";
import type { SubagentSpec } from "./executor.js";
import {
  createDelegationTools,
  isValidWorkflowName,
  parseAgentDefinition,
} from "./tool.js";

const agentDefs = new Map<string, string>();
const subagentCalls: Array<{ spec: SubagentSpec; signal?: AbortSignal }> = [];
const batchCalls: Array<{ input: {
  batchId: string;
  label: string;
  items: readonly SubagentSpec[];
  signal?: AbortSignal;
} }> = [];
const deps = {
  runBatch: async (input: {
    batchId: string;
    label: string;
    items: readonly SubagentSpec[];
    signal?: AbortSignal;
  }) => {
    batchCalls.push({ input });
    return {
      items: input.items.map((spec, i) => ({
        label: spec.label ?? `a${i}`,
        text: "ok",
        ok: true,
      })),
      totalTokens: 0,
      ok: true,
    };
  },
  runSubagent: async (spec: SubagentSpec, signal?: AbortSignal) => {
    subagentCalls.push({ spec, signal });
    return { label: spec.label ?? "sub", text: "ok", ok: true };
  },
  readAgentDefinition: async (name: string) => agentDefs.get(name) ?? null,
  listSubagents: () => [],
  getSubagentOutput: (handle: string) => ({ handle, status: "unknown" }),
  stopSubagent: (handle: string) => ({ ok: false, error: `unknown subagent handle "${handle}"` }),
};
const tools = createDelegationTools(deps);
const subagentTool = tools.find((t) => t.name === "task")!;
const subagentListTool = tools.find((t) => t.name === "task_list")!;
const subagentOutputTool = tools.find((t) => t.name === "task_output")!;
const subagentStopTool = tools.find((t) => t.name === "task_stop")!;

describe("task batch fan-out (pi shape)", () => {
  test("runs items via runBatch with shared context prepended to every spawn", async () => {
    batchCalls.length = 0;
    const result = (await subagentTool.execute({
      context: "SHARED-BG",
      tasks: [
        { name: "one", agent: "explore", task: "investigate A" },
        { name: "two", agent: "task", task: "investigate B", outputSchema: { type: "object" } },
      ],
    })) as { content: string; results: Array<{ name: string; ok: boolean }> };
    expect(result.ok).toBe(true);
    expect(result.results.map((r) => r.name)).toEqual(["one", "two"]);
    expect(batchCalls).toHaveLength(1);
    const items = batchCalls[0]!.input.items;
    expect(items).toHaveLength(2);
    expect(items[0]!.prompt).toContain("SHARED-BG");
    expect(items[0]!.prompt).toContain("investigate A");
    expect(items[0]!.label).toBe("one");
    expect(items[1]!.schema).toEqual({ type: "object" });
    expect(items[1]!.systemPrompt).toContain("general-purpose task subagent");
  });

  test("validates batch shape before spawning", async () => {
    batchCalls.length = 0;
    const missingContext = (await subagentTool.execute({
      tasks: [{ task: "x" }],
    })) as { error: string };
    expect(missingContext.error).toContain("context is required");
    const emptyTasks = (await subagentTool.execute({ context: "c", tasks: [] })) as {
      error: string;
    };
    expect(emptyTasks.error).toContain("non-empty");
    const dup = (await subagentTool.execute({
      context: "c",
      tasks: [
        { task: "a", name: "same" },
        { task: "b", name: "same" },
      ],
    })) as { error: string };
    expect(dup.error).toContain("duplicate task name");
    expect(batchCalls.length).toBe(0);
  });

  test("unknown role fails the whole call before any spawn", async () => {
    batchCalls.length = 0;
    const result = (await subagentTool.execute({
      context: "c",
      tasks: [{ agent: "mystery", task: "x" }],
    })) as { error: string };
    expect(result.error).toContain('unknown subagent "mystery"');
    expect(batchCalls.length).toBe(0);
  });
});

describe("subagent", () => {
  test("dispatches builtin explore with read-only tools (3.4)", async () => {
    subagentCalls.length = 0;
    const out = (await subagentTool.execute({ agent: "explore", prompt: "look around" })) as {
      ok?: boolean;
    };
    expect(out.ok).toBe(true);
    const call = subagentCalls[0]!;
    expect(call.spec.systemPrompt).toContain("read-only");
    expect(call.spec.toolNames).toEqual(["read", "grep", "glob", "tree", "read_image"]);
  });

  test("loads .oma/agents/<name>.md definitions (3.4)", async () => {
    subagentCalls.length = 0;
    agentDefs.set(
      "reviewer",
      "---\nname: reviewer\ntools: [read, grep]\nmodel: fake/big\n---\nYou review code carefully.",
    );
    const out = (await subagentTool.execute({ agent: "reviewer", prompt: "review" })) as {
      ok?: boolean;
    };
    expect(out.ok).toBe(true);
    const call = subagentCalls[0]!;
    expect(call.spec.systemPrompt).toBe("You review code carefully.");
    expect(call.spec.toolNames).toEqual(["read", "grep"]);
    expect(call.spec.modelId).toBe("fake/big");
    expect(call.spec.label).toBe("reviewer");
  });

  test("rejects unknown agents with a clear error and the builtin list", async () => {
    const out = (await subagentTool.execute({ agent: "nope", prompt: "x" })) as {
      ok?: boolean;
      error?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("unknown subagent");
    expect(out.error).toContain("explore, plan, task");
  });

  test("requires prompt (and agent or resume)", async () => {
    const noPrompt = (await subagentTool.execute({ agent: "explore" })) as {
      ok?: boolean;
      error?: string;
    };
    expect(noPrompt.ok).toBe(false);
    expect(noPrompt.error).toContain("prompt is required");
    const noAgent = (await subagentTool.execute({ prompt: "x" })) as {
      ok?: boolean;
      error?: string;
    };
    expect(noAgent.ok).toBe(false);
    expect(noAgent.error).toContain("agent (or resume handle)");
  });

  test("surfaces the handle and resumes with it (3.4 Phase 2)", async () => {
    subagentCalls.length = 0;
    const handle = "sub-abc123";
    const originalRunSubagent = deps.runSubagent;
    deps.runSubagent = async (spec, signal) => {
      subagentCalls.push({ spec, signal });
      return {
        label: spec.label ?? "sub",
        text: spec.resumeHandle ? "follow-up done" : "first done",
        ok: true,
        handle,
      };
    };
    try {
      const first = (await subagentTool.execute({ agent: "explore", prompt: "first" })) as {
        handle?: string;
      };
      expect(first.handle).toBe(handle);
      const resumed = (await subagentTool.execute({ resume: handle, prompt: "more" })) as {
        ok?: boolean;
        text?: string;
      };
      expect(resumed.ok).toBe(true);
      expect(resumed.text).toBe("follow-up done");
      expect(subagentCalls[1]?.spec.resumeHandle).toBe(handle);
    } finally {
      deps.runSubagent = originalRunSubagent;
    }
  });
});

describe("parseAgentDefinition", () => {
  test("parses the four frontmatter fields and body", () => {
    const def = parseAgentDefinition(
      "---\nname: reviewer\ndescription: Reviews diffs\ntools: [read, grep]\nmodel: fake/big\n---\nBody prompt",
    );
    expect(def?.systemPrompt).toBe("Body prompt");
    expect(def?.tools).toEqual(["read", "grep"]);
    expect(def?.modelId).toBe("fake/big");
    expect(def?.description).toBe("Reviews diffs");
  });

  test("returns null without a name or frontmatter", () => {
    expect(parseAgentDefinition("Just a prompt.")).toBeNull();
    expect(parseAgentDefinition("---\ntools: [read]\n---\nNo name")).toBeNull();
  });
});

describe("subagent control plane", () => {
  test("subagent_output and subagent_stop delegate to the deps", async () => {
    const out = (await subagentOutputTool.execute({ handle: "sub-x" })) as {
      status?: string;
    };
    expect(out.status).toBe("unknown");
    const stopped = (await subagentStopTool.execute({ handle: "sub-x" })) as {
      ok?: boolean;
      error?: string;
    };
    expect(stopped.ok).toBe(false);
    expect(stopped.error).toContain("unknown subagent handle");
  });

  test("subagent_list returns the dep list", async () => {
    const out = (await subagentListTool.execute({})) as { tasks?: unknown[] };
    expect(out.tasks).toEqual([]);
  });

  test("requires a handle for output/stop", async () => {
    const out = (await subagentOutputTool.execute({})) as { ok?: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("handle is required");
  });
});

describe("delegation tool names", () => {
  test("isValidWorkflowName rejects path segments", () => {
    expect(isValidWorkflowName("audit")).toBe(true);
    expect(isValidWorkflowName("../audit")).toBe(false);
    expect(isValidWorkflowName("a/b")).toBe(false);
    expect(isValidWorkflowName("")).toBe(false);
  });

  test("four delegation tools are registered", () => {
    expect(subagentTool.name).toBe("task");
    expect(subagentListTool.name).toBe("task_list");
    expect(subagentOutputTool.name).toBe("task_output");
    expect(subagentStopTool.name).toBe("task_stop");
    expect(tools).toHaveLength(4);
  });
});
```

### 4e. 新建 `apps/oh-my-agent/src/core/orchestrate/tool.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { createOrchestrateTool } from "./tool.js";

const saved = new Map<string, string>();
const deps = {
  runScript: async (input: { script: string }) => ({
    ok: true,
    totalTokens: 0,
    value: `ran:${input.script.slice(0, 8)}`,
  }),
  writeScript: (name: string, content: string) => {
    saved.set(name, content);
  },
  readScript: async (name: string) => saved.get(name) ?? null,
};
const tools = createOrchestrateTool(deps);
const runScriptTool = tools.find((t) => t.name === "workflow_run")!;

describe("workflow_run", () => {
  test("saves a script and re-runs it by name only (B8)", async () => {
    const first = (await runScriptTool.execute({ script: "const a = 1;", name: "audit" })) as {
      scriptSaved?: boolean;
      ok?: boolean;
    };
    expect(first.scriptSaved).toBe(true);
    expect(saved.get("audit")).toBe("const a = 1;");

    const second = (await runScriptTool.execute({ name: "audit" })) as {
      scriptSaved?: boolean;
      ok?: boolean;
      value?: unknown;
    };
    expect(second.scriptSaved).toBe(false);
    expect(second.ok).toBe(true);
    expect(String(second.value)).toContain("ran:const a");
  });

  test("rejects an unknown saved name", async () => {
    const out = (await runScriptTool.execute({ name: "missing" })) as {
      ok?: boolean;
      error?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("not found");
  });

  test("rejects path-escape names", async () => {
    const out = (await runScriptTool.execute({ name: "../evil" })) as {
      ok?: boolean;
      error?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("invalid workflow name");
  });

  test("requires script or name", async () => {
    const out = (await runScriptTool.execute({})) as { ok?: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("script or name");
  });
});
```

### 4f. `run-runtime.ts` 里 create-runtime 测试用到 `run_workflow` 的两个集成测试更新

`src/core/runtime/create-runtime.test.ts` 第 300-367 行测试：
- 标题改 `"task batch fans out subagents and reports delegation events"`
- 第 317 行 `name: "run_workflow"` → `name: "task"`
- 第 322-327 行 partial_json 改为：
  ```ts
              partial_json: JSON.stringify({
                context: "SHARED-BG",
                tasks: [
                  { task: "one", name: "a" },
                  { task: "two", name: "b" },
                ],
              }),
  ```

`src/core/runtime/create-runtime-workflow.test.ts` 第 63-71 行：
- `name: "run_workflow"` → `name: "task"`
- partial_json 改为：
  ```ts
              partial_json: JSON.stringify({
                context: "ctx",
                tasks: [{ task: "write a marker file with bash", name: "a" }],
              }),
  ```

**验证 Step 4**：
```bash
cd apps/oh-my-agent && bun test src/core/delegation src/core/orchestrate src/core/runtime
cd apps/oh-my-agent && bun run typecheck
```

---

## Step 5 — TUI 工具块渲染修复（`apps/oh-my-agent/src/modes/tui/tui-tool-render.ts`）

把 `renderTaskTool` 整体替换为：

```ts
/** omp-style plain-list task rendering (no card/box). */
export function renderTaskTool(item: TranscriptItem, expanded: boolean): string[] {
  const toolName = item.text.replace(/…$/, "");
  const label = typeof item.input?.label === "string" ? item.input.label : "";
  const title = `${toolName}${label ? ` · ${label}` : ""}`;
  const lines: string[] = [`\u001b[36m  ${title}\u001b[0m`];
  const result = item.result;
  const asRecord = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  // task_list: { tasks: [{handle, label, status, usage?}] }
  if (toolName === "task_list" && result && Array.isArray(asRecord(result).tasks)) {
    const tasks = asRecord(result).tasks as Array<Record<string, unknown>>;
    if (tasks.length === 0) lines.push("\u001b[2m    (no live tasks)\u001b[0m");
    for (const t of tasks) {
      const status = String(t.status ?? "?");
      const mark =
        status === "running"
          ? "\u27f3"
          : status === "failed" || status === "stopped"
            ? "\u2718"
            : "\u2714";
      lines.push(
        `\u001b[2m  ${mark} ${String(t.label ?? t.handle ?? "")} [${status}]\u001b[0m`,
      );
    }
    return lines;
  }
  // task_output: { handle, status, result: SubagentResult } — show the nested text.
  if (toolName === "task_output") {
    const status = String(asRecord(result).status ?? "");
    if (status) lines.push(`\u001b[2m    status: ${status}\u001b[0m`);
    const nested = asRecord(result).result;
    if (nested && typeof nested === "object") {
      const nestedText = String(asRecord(nested).text ?? "");
      if (nestedText.trim()) {
        lines.push(`\u001b[2m    ${nestedText.trim().slice(0, expanded ? 400 : 160)}\u001b[0m`);
      }
    }
    if (lines.length === 1) lines.push("\u001b[2m    (unknown handle)\u001b[0m");
    return lines;
  }
  const status = String(asRecord(result).status ?? "");
  if (status) lines.push(`\u001b[2m    status: ${status}\u001b[0m`);
  // Batch: { ok, content, results: [{index, name, agent, ok, text|error, ...}] }
  const results = Array.isArray(asRecord(result).results)
    ? (asRecord(result).results as Array<Record<string, unknown>>)
    : [];
  if (results.length > 0) {
    for (const r of results) {
      const name = String(r.name ?? "");
      const agent = String(r.agent ?? "");
      const mark = r.ok === false ? "\u001b[31m\u2718\u001b[0m" : "\u001b[32m\u2714\u001b[0m";
      lines.push(`  ${mark} \u001b[2m${name}${agent ? ` (${agent})` : ""}\u001b[0m`);
      const text =
        typeof r.text === "string" && r.text !== ""
          ? r.text
          : typeof r.error === "string"
            ? r.error
            : "";
      if (text.trim()) lines.push(`\u001b[2m    ${text.trim().slice(0, expanded ? 400 : 160)}\u001b[0m`);
    }
    return lines;
  }
  // Single mode / script result: content or top-level text.
  const content =
    typeof result?.content === "string"
      ? result.content
      : typeof result?.text === "string"
        ? result.text
        : "";
  if (content) {
    const text = content.trim();
    if (text) lines.push(`\u001b[2m    ${text.slice(0, expanded ? 400 : 160)}\u001b[0m`);
  }
  if (item.streaming) {
    lines.push(`\u001b[2m    \u27f3 running…\u001b[0m`);
  } else if (lines.length === 1) {
    lines.push("\u001b[2m    (done)\u001b[0m");
  }
  return lines;
}
```

（文件其余部分 `renderTodoTool`/`todoItems` 不动。`tui-render.ts` 的 `renderTool` 分支不动——`task`/`task_list`/`task_output` 名字没变。）

**验证 Step 5**：
```bash
cd apps/oh-my-agent && bun test src/modes/tui/tui-mode.test.ts src/modes/tui/tui-session.test.ts src/modes/tui/tui-e2e.test.ts
```

---

## Step 6 — 技能文档 `skills/workflow-authoring/SKILL.md`

整个 frontmatter 之后的 body 替换为：

```markdown
# Workflow Authoring

Two complementary surfaces: the `task` tool for delegating work to
subagents, and `workflow_run` for orchestration scripts.

## task — batch fan-out (preferred)

For independent items: `task({ context, tasks: [{ task, name?, agent?, outputSchema? }] })`.

- One subagent per item, bounded by the executor semaphore (max 64 items).
- `context` (required) is shared background prepended to every spawn.
- `agent` selects a role: `task` (full tools), `explore` (read-only),
  `plan` (read-only planning), or any `.oma/agents/<name>.md` definition.
- Long results spill to `.oma/workflow` with a `resultPath` — read them
  back instead of carrying them inline.
- Single background dispatch: `task({ agent, prompt, background: true })`
  returns a handle; poll it with `task_output`, stop with `task_stop`,
  list live handles with `task_list`. Follow up a finished handle with
  `task({ resume: <handle>, prompt })`.

## workflow_run — orchestration script

For loops/branches/intermediate state. The script is top-level-await JS
in a vm sandbox with NO fs/network — agents do the work:

- `agent(prompt, { schema?, label? })` — spawns one subagent, returns its result.
- `pipeline(items, fn)` — Promise.all over a mapper.
- Save with `workflow_run({ script, name })` to `.oma/workflow/<name>.js`;
  re-run later with `workflow_run({ name })` only.

## Rules

- Subagents inherit the workspace: write conflicts are YOUR sharding
  responsibility.
- Keep per-item prompts self-contained (subagents see no parent context).
- Prefer a `task` batch unless you need a loop or an intermediate value.
```

（frontmatter 的 name/description 保留；description 里 `run_workflow fan-out` 字样改为 `task batch fan-out`。）

---

## Step 7 — 全量验证（顺序执行，红了就修）

```bash
cd /root/my-agent-team

# 1. oma 单包测试（bun test 直接从 src 跑）
cd apps/oh-my-agent && bun test src/core/delegation src/core/orchestrate src/core/runtime src/modes/tui src/protocol
cd apps/oh-my-agent && bun run typecheck

# 2. 契约链构建（顺序！改了类型必须先 build 依赖包，否则下游 typecheck 看到旧 dist）
cd ../../packages/agent-contract && bun run build
cd ../api-contract && bun run build
cd ../adapter-oma-agent && bun run build
cd ../../apps/oh-my-agent && bun run build

# 3. 下游 typecheck/test
cd ../backend && bun run typecheck
cd ../backend && bun test
cd ../web && bun run typecheck
cd ../web && bun test

# 4. lint（只 lint 变更文件，避免全仓 OOM）
cd /root/my-agent-team
git diff --name-only HEAD | grep -E '\.(ts|tsx)$' | grep -v dist | xargs bunx eslint 2>/dev/null || true
```

**最后**：`grep -rn "workflow_started\|workflow_agent\|workflow_completed" apps packages --include="*.ts" --include="*.tsx" | grep -v dist | grep -v superpowers` 必须只剩 `workflowExecutionEvents`（backend workflow 引擎，无关联）或空。`grep -rn "run_workflow" apps packages skills --include="*.ts" --include="*.tsx" --include="*.md" | grep -v dist | grep -v superpowers` 必须为空。

CI 会跑 `bun run audit`（typedSource/契约门禁）——本计划的六层改名就是为满足它。

---

## Step 8 — 提交（4 笔，按路径 add，每笔后跑对应验证已在上文）

```bash
# 1. 搬家 + 内部改名（Step 1+2）
git add apps/oh-my-agent/src/core/delegation apps/oh-my-agent/src/core/orchestrate \
        apps/oh-my-agent/src/core/runtime/run-runtime.ts \
        apps/oh-my-agent/src/core/runtime/create-runtime.ts
git commit -m "refactor(oh-my-agent): move workflow core into delegation and orchestrate modules"

# 2. 事件链路改名（Step 3）
git add apps/oh-my-agent/src/core/runtime/agent-event.ts apps/oh-my-agent/src/protocol/mapping.ts \
        apps/oh-my-agent/src/core/delegation apps/oh-my-agent/src/core/orchestrate \
        apps/oh-my-agent/src/core/runtime/run-runtime.ts \
        apps/oh-my-agent/src/modes/tui/view-state.ts apps/oh-my-agent/src/modes/tui/tui-mode.test.ts \
        apps/oh-my-agent/src/modes/tui/tui-session.test.ts \
        packages/adapter-oma-agent/src/event-mapper.ts \
        packages/agent-contract/src/event.ts packages/api-contract/src/sse.ts \
        apps/backend/src/features/agent-run/execution-input.ts apps/web/src/hooks/useConversation.ts
git commit -m "refactor(agent-contract): rename workflow events to delegation across the contract chain"

# 3. 工具面收敛 + TUI 渲染（Step 4+5）
git add apps/oh-my-agent/src/core/delegation apps/oh-my-agent/src/core/orchestrate \
        apps/oh-my-agent/src/core/runtime/run-runtime.ts apps/oh-my-agent/src/modes/tui/tui-tool-render.ts \
        apps/oh-my-agent/src/core/runtime/create-runtime.test.ts \
        apps/oh-my-agent/src/core/runtime/create-runtime-workflow.test.ts
git commit -m "feat(oh-my-agent): merge run_workflow into task batch and fix TUI delegation rendering"

# 4. 技能文档（Step 6）
git add skills/workflow-authoring/SKILL.md
git commit -m "docs(workflow): update workflow-authoring skill for task batch"
```

注意：如果一笔提交里混入了未验证的文件，用 `git reset`（mixed）后按路径重新 `git add`。提交信息英文、带 scope、无 CJK。

---

## 风险与常见坑（执行前读三遍）

1. **六层事件改名漏一层** → 后端 SSE typedSource 校验会拒收事件或 CI audit 红。逐层对照 Step 3 清单打勾。
2. **`workflowId` → `batchId` 全替换**时要跳过 `.oma/workflow` 路径字符串和 `wf:` 前缀——这些是**存储格式**，不是事件字段。
3. **dist 手动改** = 白干。build 后 dist 自动更新，测试跑 src。
4. **executor 测试里 `"echo:wf:wf1:a0"` 断言**依赖 sessionId 前缀，不能改。
5. `crypto.randomUUID()` 在 `delegation/tool.ts` 里必须有对应 import（原文件已有）。
6. `apps/web` typecheck 依赖 `packages/agent-contract` + `packages/api-contract` + `apps/oh-my-agent` 的 dist——按 Step 7 的构建顺序来。
7. `apps/backend` 的 TELEMETRY_EVENT_TYPES 缺 `delegation_batch_failed` 是有意的（failed 走 opaque `backend.oma.*` 通道，与现状一致）。
