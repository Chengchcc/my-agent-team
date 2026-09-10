# hub：统一协调面（task / bash / eval 后台能力升级）

**日期**: 2026-09-10
**状态**: 待执行（flash 模型按本 spec 机械执行）
**基线**: HEAD = 9a6b8e7e（addressable subagents 已落地）
**目标**: 引入单一 `hub` 工具，吸收 omp hub 的 **jobs + messaging 两个半**（不含 launch 进程监督），统一 oma 的 task 子代理控制面与 bash/eval 后台 job 控制面；补齐自投递、会话作用域、TTL、wait、进程树 kill。

---

## 1. 设计原则

1. **一个注册表，三种条目**：bash / eval / subagent 统一进 `coordination/registry.ts`，`hub jobs` 一张表看全。
2. **spawn 面与控制面分离**：`task` / `workflow_run` / bash `async:true` / eval `async:true` 只负责**派发**；查询、等待、注入、停止全部走 `hub`。
3. **self-delivery 统一**：bash/eval/subagent 完成都走同一个 completion listener → TUI 去抖注入（保留现有 `OMA_BG_INJECT=0` 降级路径）。
4. **会话作用域 + TTL**：注册表按 `scope` 隔离；completed/failed/stopped 条目 5min TTL + 64 条上限（running 永不淘汰）。
5. **不做**：进程监督（launch 半）、IrcBus 邮箱/双向 messaging（子代理是叶子）、auto-background 阈值（显式 `async:true` 保留）。

## 2. 目标架构

```
apps/oh-my-agent/src/core/
├── coordination/                  # 新增
│   ├── registry.ts                # 统一注册表（进程级 Map，scope + TTL + settle promise）
│   ├── hub-tool.ts                # hub 工具（模型面）
│   └── index.ts
├── delegation/
│   ├── tool.ts                    # 收敛：只返回 [task]
│   ├── executor.ts                # 消费 coordination registry；保留 liveSessions/steer/stop
│   └── （删除 registry.ts + registry.test.ts，并入 coordination）
├── orchestrate/                   # 不动
├── tools/
│   ├── bash.ts                    # 删 jobAction/jobId；async 注册进 coordination registry
│   ├── eval.ts                    # 同上；timedOut 精确化
│   └── （删除 bg-jobs.ts，completion listener 移入 coordination/registry.ts）
├── modes/tui/
│   ├── tui-io.ts                  # completion listener 改从 coordination 订阅；subagent 完成也注入
│   ├── tui-render.ts              # toolName "hub" → renderHubTool
│   ├── tui-tool-render.ts         # 新增 renderHubTool；renderTaskTool 删 task_list/task_output 分支
│   └── tui-mode.ts                # 传 coordinationScope
└── runtime/
    ├── run-runtime.ts             # 接线 hub；scope 透传
    └── agent-event.ts             # 不动（delegation_* 事件已够）
```

## 3. 核心契约

### 3a. `coordination/registry.ts`（新，模块级单例）

```ts
import type { SessionStore } from "../agent-runtime.js";
import type { SubagentResult, SubagentSpec } from "../delegation/executor.js";

export type EntryStatus = "running" | "completed" | "failed" | "stopped";
export type EntryKind = "bash" | "eval" | "subagent";

export interface RegistryEntry {
  readonly id: string;            // bg_N | eval_N | sub-<uuid>
  readonly kind: EntryKind;
  readonly scope: string;         // TUI: "tui-<pid>"；backend: runId
  readonly label: string;         // bash 命令 / eval 代码头 / 子代理 label
  readonly startedAt: number;
  status: EntryStatus;
  finishedAt: number | null;
  partialText: string;            // 累积流式文本，尾截 4000
  settle?: Promise<void>;         // 完成时 resolve（wait 用）
  // process（bash/eval）专属
  output?: string;                // 完整输出（cap 后）
  exitCode?: number | null;
  killed?: boolean;
  timedOut?: boolean;
  isError?: boolean;
  kill?: () => void;
  // subagent 专属
  result?: SubagentResult;
  spec?: SubagentSpec;
  store?: SessionStore;
  sessionId?: string;
  batchId?: string;
  agentId?: string;
  stopRequested?: boolean;
}

export interface EntryRow {
  id: string;
  kind: EntryKind;
  status: EntryStatus;
  label: string;
  partialText: string;
  exitCode?: number | null;
  isError?: boolean;
}

const RUNNING_CAP = 32;          // 进程类 running 上限（注册时拒绝）
const NON_RUNNING_CAP = 64;      // 完成类上限（驱逐最旧 finishedAt）
const TTL_MS = 5 * 60 * 1000;

export function registerEntry(entry: RegistryEntry): { ok: true } | { ok: false; error: string };
export function getEntry(id: string): RegistryEntry | undefined;
export function updateEntry(id: string, patch: Partial<RegistryEntry>): void;
export function appendEntryPartial(id: string, text: string): void;
export function listEntries(scope: string): EntryRow[];
export function waitEntries(opts: {
  ids?: readonly string[];
  scope: string;
  timeoutMs: number;              // 0 = 无限
}): Promise<{ settled: EntryRow[]; timedOut: boolean }>;
export function stopEntry(id: string): { ok: boolean; error?: string };
export function setEntryCompletionListener(cb: ((entry: RegistryEntry) => void) | null): void;
export function notifyEntryCompletion(entry: RegistryEntry): void;
export function clearScope(scope: string): void;
```

语义要点：
- `registerEntry`：running 条目数 ≥ 32 时对 `bash`/`eval` 返回 `{ok:false, error:"too many running jobs"}`（subagent 不受此限，executor 有独立信号量）；每次注册时顺带 `prune()`（TTL + NON_RUNNING_CAP 驱逐最旧 finishedAt 的非 running 条目）。
- `waitEntries`：ids 省略 = scope 下所有 running；对每个命中条目 `Promise.race` 其 `settle` 与 timeout；返回已 settle 的行 + timedOut 标志。永不 hang（无匹配 id 直接返回空 settled）。
- `stopEntry`：`bash`/`eval` 调 `kill()`；`subagent` 置 `stopRequested=true`（真实 stop 由 executor 的 live session 执行——见 3e 接线）。
- completion listener：单订阅（同旧 bg-jobs.ts 模式），`notifyEntryCompletion` 在 bash/eval/subagent settle 时调用；异常吞掉。

### 3b. `coordination/hub-tool.ts`（新）

```ts
export interface HubToolDeps {
  readonly scope: string;
  readonly list: (scope: string) => EntryRow[];
  readonly get: (id: string) => RegistryEntry | undefined;
  readonly wait: (opts: { ids?: readonly string[]; scope: string; timeoutMs: number }) =>
    Promise<{ settled: EntryRow[]; timedOut: boolean }>;
  readonly stop: (id: string) => { ok: boolean; error?: string };
  readonly steer: (handle: string, prompt: string) => { ok: boolean; error?: string };
}

export function createHubTool(deps: HubToolDeps): readonly PluginTool[];
```

工具 schema：

```ts
name: "hub"
executionMode: "serial"
inputSchema: {
  type: "object",
  properties: {
    op: { type: "string", enum: ["jobs", "output", "wait", "steer", "stop"] },
    id:  { type: "string" },           // output / steer / stop
    ids: { type: "array", items: { type: "string" } },  // wait
    prompt: { type: "string" },        // steer
    timeoutMs: { type: "number" },     // wait；0 = 无限，默认 60_000
  },
  required: ["op"],
}
```

各 op 返回：
- `jobs` → `{ items: EntryRow[] }`
- `output` → `{ id, status, partialText, output?, result?, exitCode?, isError? }`（无 id 返回 `{ok:false,error:"id is required"}`；未知 id `{ok:false,error:"unknown id"}`）
- `wait` → `{ waited: EntryRow[], timedOut }`
- `steer` → `{ ok, error? }`（id/prompt 必填校验；非 subagent 条目返回 error "only subagent handles can be steered"）
- `stop` → `{ ok, error? }`

description 一句话风格（模型面）：

```
"Unified coordination for background work. jobs: snapshot of all background
bash/eval jobs and task subagents (id, kind, status, label, partial). output:
fetch one entry by id (streaming partialText while running, final result when
settled). wait: block until the given ids (default: all running) settle or
timeoutMs (0 = indefinite) elapses. steer: inject a message into a RUNNING
subagent. stop: kill a bash/eval job or stop a subagent."
```

### 3c. bash / eval 改造

`createBashTool(opts)` 签名增加 `scope: string`；`createEvalTool(opts)` 增加 `scope: string`。

- 删除 schema 中的 `jobAction`/`jobId` 与 execute 里的 jobAction 分支。
- `async: true` 时：`registerEntry({id: bg_N / eval_N, kind, scope, label, status:"running", startedAt, settle: deferred.promise, kill})`；注册失败（running 满）返回错误文本。返回文本改为 `Backgrounded as job <id>; collect with hub {op:"output", id:"<id>"} or hub {op:"wait", ids:["<id>"]}.`
- 完成时：更新 entry（status/output/exitCode/killed/timedOut/isError/finishedAt）→ `resolve(settle)` → `notifyEntryCompletion(entry)`。
- **bash kill 进程树**：`kill()` 实现 = `try { process.kill(-proc.pid, "SIGKILL") } catch { proc.kill(); }`（NullBashSandbox 用 setsid 启动，负 pid 杀整组；SIGKILL-first 沿用沙箱约定）。同时置 `killed=true`。
- **eval timedOut 精确化**：eval 的 job 加显式计时器（与 bash 相同）：`timeoutMs > 0` 时 `setTimeout → controller.abort() + timedOut=true`；`timeoutMs === 0` 无死线（保持现有语义）。`runInSandbox` 仍传 signal，但 timedOut 由计时器裁定（不再恒 false）。完成时用计时器状态填充 `timedOut`。
- 移除对 `bg-jobs.js` 的 import（文件删除）；`countRunningBashJobs`/`countRunningEvalJobs`（TUI 状态栏 chip）改为读 coordination registry：`listEntries(scope).filter(kind==="bash" && status==="running").length`——但 chip 在 tui-render 用固定 scope？改为 `countRunningJobs()` 单函数（kind 过滤）从 coordination registry 导出，tui-render 改 import。

### 3d. delegation executor 改造

- 删除 `delegation/registry.ts` 及其测试；`executor.ts` 改 import `coordination/registry.ts` 的 `registerEntry/getEntry/updateEntry/appendEntryPartial/listEntries/notifyEntryCompletion/clearScope`。
- `DelegationExecutorOptions` 增加 `readonly scope: string`。
- `runSubagent`：fresh dispatch 时 `registerEntry({ id: handle, kind:"subagent", scope: opts.scope, label: spec.label ?? agentId, startedAt, status:"running", finishedAt:null, partialText:"", settle: deferred.promise, spec, store, sessionId, batchId, agentId })`；resume 时 `getEntry(resumeHandle)`（校验 `kind === "subagent"`，否则错误）。
- 事件转发分支里的 `appendSubagentPartial` → `appendEntryPartial`。
- `finish()` / background `.then` 的终态写回改 `updateEntry(handle, {...})` + `resolve(settle)` + `notifyEntryCompletion(getEntry(handle))`。stop 判定沿用 `entry.stopRequested`。
- 控制面函数签名不变（`listSubagents/getSubagentOutput/stopSubagent/steerSubagent/stopLiveSubagents`），实现改为读 coordination registry（list/get 直接 registry；steer/stop 需要 `liveSessions`）。这些函数由 run-runtime 接线给 hub deps，**不再**由 delegation 工具暴露（模型面只有 hub）。
- `stopLiveSubagents()` 行为不变（只停本 Run 活循环；registry 条目保留）。

### 3e. `delegation/tool.ts` 收敛

- 删除 `task_list`/`task_output`/`task_steer`/`task_stop` 四个工具与 deps 里对应字段（`listSubagents/getSubagentOutput/stopSubagent/steerSubagent`）。
- `DelegationToolDeps` 只剩 `runBatch` + `runSubagent` + `readAgentDefinition`。
- 返回 `[task]`。task 工具 description 把 "poll via task_output, steer via task_steer" 改为 "poll/wait via hub, steer via hub"。

### 3f. `run-runtime.ts` 接线

- `RunRuntimeDeps` 增加 `readonly coordinationScope?: string`。
- 组装处 `const scope = deps.coordinationScope ?? deps.runId;`
- `createBashTool({..., scope})`、`createEvalTool({ workspaceRoot, scope })`、`createDelegationExecutor({..., scope})`。
- plugins：
  ```ts
  plugins.push({ name: "delegation-tools", tools: createDelegationTools({ runBatch, runSubagent, readAgentDefinition }) });
  plugins.push({ name: "orchestrate-tool", tools: createOrchestrateTool({...}) });   // 不变
  plugins.push({
    name: "hub-tool",
    tools: createHubTool({
      scope,
      list: (s) => delegationExecutor.listSubagents(s),   // 注意签名统一
      get: (id) => getEntry(id),
      wait: (o) => waitEntries(o),
      stop: (id) => stopEntry(id),                          // 见下：subagent stop 需要 executor 参与
      steer: (h, p) => delegationExecutor.steerSubagent(h, p),
    }),
  });
  ```
- **subagent stop 接线**：`stopEntry(id)` 对 subagent 只置 `stopRequested`；真正的 `session.stop()` 由 executor 执行。接线方式：hub deps 的 `stop` 改为 `(id) => delegationExecutor.stopSubagent(id)`（executor.stopSubagent 内部：置 stopRequested + live session.stop + updateEntry status）——即 hub 不直接调 registry.stopEntry，而是走 executor 的 stop；bash/eval 的 stop 走 registry.stopEntry。为统一，spec 规定：`hub` deps.stop = run-runtime 提供的 `stopById(id)`：`kind==="subagent"` → `delegationExecutor.stopSubagent(id)`；否则 `stopEntry(id)`。
- `close()` 不变（`stopLiveSubagents`）。

### 3g. TUI

- `tui-mode.ts`：模块级 `const COORDINATION_SCOPE = \`tui-${process.pid}\`;`，`createOmaRuntime({..., coordinationScope: COORDINATION_SCOPE})`。
- `tui-io.ts`：删 `setBgJobCompletionListener` import；改 `setEntryCompletionListener`。监听体：
  - `entry.kind === "bash" | "eval"` → 沿用现有文案（state + tail）。
  - `entry.kind === "subagent"` → 文案 `sub-<id> (<label>) — ok|error|stopped` + `entry.result?.text` 尾（400 字符）或 partialText 尾。
  - 两种都进同一个 `bgPending` 去抖（1.5s）→ `OMA_BG_INJECT=0` 时 `appendNotice`，否则 `injectUserMessage`。
- `tui-render.ts`：`renderTool` 分支加 `if (toolName === "hub") return renderHubTool(item, expanded);`。
- `tui-tool-render.ts`：
  - 新增 `renderHubTool(item, expanded)`：
    - 从 `item.input.op` 分支：`jobs` → 逐行 `⚙ <id> <kind> [status] <label>` + partial 尾；`output` → `status:` + partialText/result.text；`wait` → `waited N` + 逐行；`steer`/`stop` → ok/error 行。streaming 时显示 `⟳ waiting…`（wait op）。
  - `renderTaskTool` 删除 `task_list`/`task_output` 分支（只留 batch/single 渲染），title 直接 `task`。
- `view-state.ts` 不动。

### 3h. 删除文件

- `core/tools/bg-jobs.ts`（completion listener 迁走；`countRunning*` 由 coordination registry 提供）。
- `core/delegation/registry.ts` + `core/delegation/registry.test.ts`。

## 4. 分步执行（每步全绿再进下一步）

### Step 1 — coordination/registry.ts + 测试
新建 registry（3a 全量）+ `registry.test.ts`（注册/scope 隔离/TTL 驱逐/running 上限/wait 竞争/stop 分发/completion listener）。纯新代码，不碰现有文件。

**验证**: `cd apps/oh-my-agent && bun test src/core/coordination`

### Step 2 — bash/eval 迁移
按 3c 改 bash.ts/eval.ts；删 bg-jobs.ts；`tui-render.ts` 的 `countRunningBashJobs/countRunningEvalJobs` 改 `countRunningJobs()`（coordination 导出）；tui-io 暂不换 listener（编译会断，随 Step 5 一起换——**注意**：本步先给 coordination/registry.ts 导出 `countRunningJobs(scope: string): number`，bash/eval 的 chip 函数先保留薄封装 `countRunningBashJobs = () => countRunningJobs(scope)`？**简化**：本步直接把 chip 改为 `countRunningJobs()` 从 registry 全局统计，TUI 单会话所以 scope 无需过滤）。

更新 bash.test.ts/eval.test.ts：删 jobAction 断言，改 hub 语义断言（async 注册、settle、notify、kill）。

**验证**: `cd apps/oh-my-agent && bun test src/core/tools src/core/coordination`

### Step 3 — delegation 迁移 + tool 收敛
按 3d/3e 改 executor.ts/tool.ts；删 delegation/registry.ts；更新 executor-subagent.test.ts（registry import 改 coordination、scope 参数、`clearScope`）、tool.test.ts（只剩 task + 5 工具断言删除）。

**验证**: `cd apps/oh-my-agent && bun test src/core/delegation src/core/orchestrate`

### Step 4 — hub-tool + run-runtime 接线
按 3b 写 hub-tool.ts + hub-tool.test.ts；按 3f 改 run-runtime.ts（scope、plugins、close）。此时模型面 = task + workflow_run + hub + bash/eval（无 jobAction）。

**验证**: `cd apps/oh-my-agent && bun test src/core/coordination src/core/runtime/create-runtime.test.ts src/core/runtime/create-runtime-workflow.test.ts`

### Step 5 — TUI
按 3g 改 tui-mode/tui-io/tui-render/tui-tool-render；新增 renderHubTool 测试（tui-mode.test.ts 补一个 hub 折叠断言）。

**验证**: `cd apps/oh-my-agent && bun test src/modes/tui/tui-mode.test.ts src/modes/tui/tui-session.test.ts`

### Step 6 — 全量验证
```bash
cd apps/oh-my-agent && bun run typecheck && bun test && bun run build
cd ../backend && bun run typecheck && bun test        # 无契约变更，应绿
cd ../web && bun run typecheck                        # 应绿
grep -rn "task_list\|task_output\|task_steer\|task_stop\|jobAction\|bg-jobs" apps/oh-my-agent/src --include="*.ts" | grep -v dist   # 必须为空（除注释）
```

## 5. 提交方案（4 笔，路径 add，HUSKY=0）

1. `feat(oh-my-agent): add coordination registry for background jobs and subagents` — Step 1
2. `refactor(oh-my-agent): migrate bash and eval background jobs onto the coordination registry` — Step 2
3. `feat(oh-my-agent): unify delegation control plane into the hub tool` — Step 3+4
4. `feat(oh-my-agent): render hub ops and unify completion injection in the TUI` — Step 5

## 6. 铁律 / 风险

1. **模型面破坏性变更**：`task_list/task_output/task_steer/task_stop/jobAction` 全删——老 transcript 的 tool_use resume 会 fail。接受（pre-1.0），不建兼容层。
2. **不碰 dist**（build 生成）；不碰 docs/superpowers 旧档案。
3. **subagent 跨 Run 复活依赖 scope 稳定**：TUI 用 `tui-<pid>`（进程内稳定）；backend 用 runId（进程即 Run）。若 tui-mode 未来支持单进程多会话并行，需把 scope 换成会话 id。
4. **settle promise 必须 resolve**：bash/eval/subagent 三条 settle 路径都要 resolve，否则 `hub wait` 永久挂起——每个 settle 点配一个测试。
5. **kill 进程树**用负 pid SIGKILL-first；catch 回退 `proc.kill()`。加回归测试（setsid 孙进程被杀）。
6. **wait 语义**：`hub wait` 是阻塞工具调用，`executionMode:"serial"`；timeout 默认 60s；`0` 无限。不实现 smart ladder（模型不应花 turn 轮询）。
7. 审计门禁（CI）：`bun run audit` 的 typedSource/契约门禁不受影响（hub 是 native 工具，无新事件）；文档门禁：AGENTS.md 工具表如提及 task_list 需同步（执行时 grep 确认）。

## 7. 已知不做（留待后续）

- launch 进程监督（pi hub 第三半）
- auto-background 阈值（bash >60s 自动后台）
- 双向 messaging / 邮箱（子代理是叶子）
- `hub wait` smart poll ladder
