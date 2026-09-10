# hub 协调面执行计划（flash 模型机械执行版）

**对应 spec**: `docs/superpowers/specs/2026-09-10-hub-coordination.md`（执行前先读）
**基线**: HEAD = `9a6b8e7e`，工作区 clean
**目标**: 落地 spec 的 6 步；每步全绿再进下一步；4 笔提交。

---

## 0. 铁律

1. **不碰 dist**（build 生成）；不碰 `docs/superpowers/**` 旧档案（新写的 spec/plan 除外）。
2. **模型面破坏性变更**：`task_list`/`task_output`/`task_steer`/`task_stop`/bash/eval 的 `jobAction` 全删，接受老 transcript 断链，不建兼容层。
3. 提交：英文、带 scope（`oh-my-agent`）、HUSKY=0、按路径 add。
4. 每步验证命令失败就停下修，不要带病进下一步。

---

## Step 1 — `coordination/registry.ts` + 测试（纯新增）

### 1a. 新建 `apps/oh-my-agent/src/core/coordination/registry.ts`

```ts
import type { SessionStore } from "../agent-runtime.js";
import type { SubagentResult, SubagentSpec } from "../delegation/executor.js";

export type EntryStatus = "running" | "completed" | "failed" | "stopped";
export type EntryKind = "bash" | "eval" | "subagent";

export interface RegistryEntry {
  readonly id: string;
  readonly kind: EntryKind;
  readonly scope: string;
  readonly label: string;
  readonly startedAt: number;
  status: EntryStatus;
  finishedAt: number | null;
  partialText: string;
  settle?: Promise<void>;
  output?: string;
  exitCode?: number | null;
  killed?: boolean;
  timedOut?: boolean;
  isError?: boolean;
  kill?: () => void;
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

const RUNNING_CAP = 32;
const NON_RUNNING_CAP = 64;
const TTL_MS = 5 * 60 * 1000;
const MAX_PARTIAL_CHARS = 4000;

const entries = new Map<string, RegistryEntry>();
let completionListener: ((entry: RegistryEntry) => void) | null = null;

function prune(): void {
  const now = Date.now();
  for (const [id, e] of entries) {
    if (e.status !== "running" && e.finishedAt !== null && now - e.finishedAt > TTL_MS) {
      entries.delete(id);
    }
  }
  let nonRunning = [...entries.values()].filter((e) => e.status !== "running");
  nonRunning.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  while (nonRunning.length > NON_RUNNING_CAP) {
    entries.delete(nonRunning.shift()!.id);
  }
}

export function registerEntry(
  entry: RegistryEntry,
): { ok: true } | { ok: false; error: string } {
  if (entry.kind !== "subagent") {
    const running = [...entries.values()].filter(
      (e) => e.kind !== "subagent" && e.status === "running",
    ).length;
    if (running >= RUNNING_CAP) {
      return { ok: false, error: `too many running jobs (${running}/${RUNNING_CAP})` };
    }
  }
  entries.set(entry.id, entry);
  prune();
  return { ok: true };
}

export function getEntry(id: string): RegistryEntry | undefined {
  return entries.get(id);
}

export function updateEntry(id: string, patch: Partial<RegistryEntry>): void {
  const e = entries.get(id);
  if (e) Object.assign(e, patch);
}

export function appendEntryPartial(id: string, text: string): void {
  const e = entries.get(id);
  if (!e) return;
  e.partialText = (e.partialText + text).slice(-MAX_PARTIAL_CHARS);
}

function row(e: RegistryEntry): EntryRow {
  return {
    id: e.id,
    kind: e.kind,
    status: e.status,
    label: e.label,
    partialText: e.partialText,
    ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
    ...(e.isError !== undefined ? { isError: e.isError } : {}),
  };
}

export function listEntries(scope: string): EntryRow[] {
  return [...entries.values()].filter((e) => e.scope === scope).map(row);
}

export function countRunningJobs(): number {
  let n = 0;
  for (const e of entries.values()) if (e.status === "running") n++;
  return n;
}

export async function waitEntries(opts: {
  ids?: readonly string[];
  scope: string;
  timeoutMs: number;
}): Promise<{ settled: EntryRow[]; timedOut: boolean }> {
  const targets = [...entries.values()].filter(
    (e) => e.scope === opts.scope && e.status === "running" && (!opts.ids || opts.ids.includes(e.id)),
  );
  if (targets.length === 0) return { settled: [], timedOut: false };
  const settles = targets
    .filter((e) => e.settle)
    .map((e) => e.settle!.then(() => row(e)));
  if (settles.length === 0) return { settled: [], timedOut: false };
  const deadline = opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : null;
  const timer = deadline
    ? new Promise<{ timedOut: true }>((resolve) => {
        const id = setTimeout(() => resolve({ timedOut: true }), Math.max(0, deadline - Date.now()));
        void Promise.all(settles).finally(() => clearTimeout(id));
      })
    : new Promise<{ timedOut: true }>(() => {});
  const result = await Promise.race([Promise.all(settles), timer]);
  if ("timedOut" in result) return { settled: [], timedOut: true };
  return { settled: result, timedOut: false };
}

export function stopEntry(id: string): { ok: boolean; error?: string } {
  const e = entries.get(id);
  if (!e) return { ok: false, error: `unknown id "${id}"` };
  if (e.kind === "subagent") {
    e.stopRequested = true;
    return { ok: true };
  }
  if (e.status !== "running") return { ok: true };
  try {
    e.kill?.();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true };
}

export function setEntryCompletionListener(cb: ((entry: RegistryEntry) => void) | null): void {
  completionListener = cb;
}

export function notifyEntryCompletion(entry: RegistryEntry): void {
  if (!completionListener) return;
  try {
    completionListener(entry);
  } catch {
    /* a broken UI listener never breaks the job */
  }
}

export function clearScope(scope: string): void {
  for (const [id, e] of entries) if (e.scope === scope) entries.delete(id);
}

export function clearAll(): void {
  entries.clear();
}
```

注意：`import type { SubagentResult, SubagentSpec } from "../delegation/executor.js"` 是 type-only（运行时无环；executor 会 runtime import 本文件）。

### 1b. 新建 `apps/oh-my-agent/src/core/coordination/registry.test.ts`

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { createInMemorySessionStore } from "../agent-runtime.js";
import {
  appendEntryPartial,
  clearAll,
  getEntry,
  listEntries,
  registerEntry,
  stopEntry,
  updateEntry,
  waitEntries,
} from "./registry.js";

function processEntry(id: string, scope: string) {
  const { promise, resolve } = Promise.withResolvers<void>();
  return {
    id,
    kind: "bash" as const,
    scope,
    label: `cmd-${id}`,
    startedAt: Date.now(),
    status: "running" as const,
    finishedAt: null,
    partialText: "",
    settle: promise,
    resolve,
  };
}

describe("coordination registry", () => {
  afterEach(() => clearAll());

  test("register/get/list round-trips within a scope", () => {
    const e = processEntry("bg_1", "s1");
    registerEntry({ ...e, settle: e.settle });
    expect(getEntry("bg_1")?.kind).toBe("bash");
    expect(listEntries("s1").map((r) => r.id)).toEqual(["bg_1"]);
    expect(listEntries("s2")).toEqual([]); // scope isolation
  });

  test("partial text accumulates capped", () => {
    registerEntry(processEntry("bg_1", "s1"));
    appendEntryPartial("bg_1", "hello ");
    appendEntryPartial("bg_1", "world");
    expect(getEntry("bg_1")?.partialText).toBe("hello world");
  });

  test("stopEntry kills process entries via their kill callback", () => {
    let killed = 0;
    registerEntry({ ...processEntry("bg_1", "s1"), kill: () => killed++ });
    expect(stopEntry("bg_1").ok).toBe(true);
    expect(killed).toBe(1);
    expect(stopEntry("missing").ok).toBe(false);
  });

  test("stopEntry marks subagents stopRequested without killing", () => {
    registerEntry({
      id: "sub-1",
      kind: "subagent",
      scope: "s1",
      label: "worker",
      startedAt: Date.now(),
      status: "running",
      finishedAt: null,
      partialText: "",
      store: createInMemorySessionStore(),
    });
    expect(stopEntry("sub-1").ok).toBe(true);
    expect(getEntry("sub-1")?.stopRequested).toBe(true);
  });

  test("waitEntries resolves when jobs settle and times out otherwise", async () => {
    const a = processEntry("bg_1", "s1");
    const b = processEntry("bg_2", "s1");
    registerEntry(a);
    registerEntry(b);
    a.resolve();
    const done = await waitEntries({ scope: "s1", timeoutMs: 2000 });
    expect(done.settled.map((r) => r.id)).toEqual(["bg_1"]);
    expect(done.timedOut).toBe(false);
    const stuck = await waitEntries({ scope: "s1", timeoutMs: 50 });
    expect(stuck.timedOut).toBe(true);
  });

  test("registerEntry rejects process jobs past the running cap", () => {
    for (let i = 0; i < 32; i++) {
      const e = processEntry(`bg_${i}`, "s1");
      registerEntry({ ...e, settle: e.settle });
    }
    const extra = processEntry("bg_x", "s1");
    const out = registerEntry({ ...extra, settle: extra.settle });
    expect(out.ok).toBe(false);
    expect(String((out as { error: string }).error)).toContain("too many running jobs");
  });
});
```

### 1c. 验证

```bash
cd apps/oh-my-agent && bun test src/core/coordination && bun run typecheck
```

---

## Step 2 — bash/eval 迁移到 coordination registry

### 2a. `src/core/tools/bash.ts`

1. 头部 import：删 `import { notifyBgJobCompletion } from "./bg-jobs.js";`；加
   ```ts
   import {
     notifyEntryCompletion,
     registerEntry,
     updateEntry,
     getEntry,
     type RegistryEntry,
   } from "../coordination/registry.js";
   ```
2. 删模块级 `jobs` Map、`nextJobSeq`、`MAX_JOBS`、`countRunningBashJobs`、`BashJob` 接口中不再需要的字段（保留 `id/command/output/truncated/bytes/startedAt/finishedAt/exitCode/timedOut/killed/timer` 及 `proc` 引用）。保留 `let nextJobSeq = 1;` 用于 id。
3. `createBashTool(opts)` 签名加 `scope: string`（解构处 `const { scope, workspaceRoot } = opts;`）。
4. `startJob` 重写：
   ```ts
   function startJob(command, cwd, env, timeoutMs): BashJob {
     const id = `bg_${nextJobSeq++}`;
     const proc = launcher.spawn(command, { cwd, env });
     const job: BashJob = { id, command, proc, output: "", truncated: false, bytes: 0,
       startedAt: Date.now(), finishedAt: null, exitCode: null, timedOut: false, killed: false, timer: null };
     const { promise: settle, resolve: settleResolve } = Promise.withResolvers<void>();
     const reg = registerEntry({
       id, kind: "bash", scope, label: command, startedAt: Date.now(),
       status: "running", finishedAt: null, partialText: "",
       settle,
       kill: () => {
         job.killed = true;
         try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill(); }
       },
     });
     if (!reg.ok) { proc.kill(); throw new Error(reg.error); }
     ...pump 不变...
     if (timeoutMs > 0) { job.timer = setTimeout(() => { job.timedOut = true; kill(); }, timeoutMs); }
     void proc.exited.then((code) => {
       job.exitCode = code; job.finishedAt = Date.now();
       if (job.timer) clearTimeout(job.timer);
       updateEntry(id, { status: code === 0 && !job.timedOut ? "completed" : "failed",
         finishedAt: job.finishedAt, exitCode: code, timedOut: job.timedOut, killed: job.killed,
         output: job.output.slice(-2000), isError: code !== 0 || job.timedOut });
       settleResolve();
       const e = getEntry(id); if (e) notifyEntryCompletion(e);
     }).catch(() => { job.finishedAt = Date.now(); if (job.timer) clearTimeout(job.timer); settleResolve(); });
     return job;
   }
   ```
   （`kill` 引用 `job` 需在注册前定义 job——按上序：先 `const job`，后 registerEntry。注意 kill 闭包引用 job 是自引用，TDZ 在调用时已过，TS 允许。）
5. 删除 execute 里整个 `if (jobAction) {...}` 分支（含 list/output/kill）与 schema 中的 `jobAction`/`jobId` 属性。
6. `async: true` 分支的返回文本改为：
   ```ts
   return { content: `Backgrounded as job ${job.id}; collect with hub {op:"output", id:"${job.id}"} or hub {op:"wait", ids:["${job.id}"]}.` };
   ```
7. 删除文件尾的 `countRunningBashJobs` 导出。

### 2b. `src/core/tools/eval.ts`

1. 删 `import { notifyBgJobCompletion } from "./bg-jobs.js";`，加 coordination import（同 bash）。
2. 删模块级 `jobs` Map / `MAX_JOBS` / `countRunningEvalJobs`；保留 `nextJobSeq`。
3. `createEvalTool(opts)` 签名加 `scope: string`。
4. async 分支重写：
   ```ts
   if ((input as { async?: boolean }).async === true) {
     const id = `eval_${nextJobSeq++}`;
     const controller = new AbortController();
     let timedOut = false;
     let killed = false;
     let timer: ReturnType<typeof setTimeout> | undefined;
     const { promise: settle, resolve: settleResolve } = Promise.withResolvers<void>();
     const reg = registerEntry({
       id, kind: "eval", scope, label: code.slice(0, 80), startedAt: Date.now(),
       status: "running", finishedAt: null, partialText: "",
       settle,
       kill: () => { killed = true; controller.abort(); },
     });
     if (!reg.ok) return { content: `Error: ${reg.error}`, isError: true };
     const timeoutMs = input.timeout ?? defaultEvalTimeoutMs();   // 沿用原 timeout 解析，0 = 无死线
     if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
     void (async () => {
       const done = await runCell(controller.signal);
       if (timer) clearTimeout(timer);
       updateEntry(id, { status: done.isError ? "failed" : "completed",
         finishedAt: Date.now(), exitCode: done.exitCode, timedOut, killed,
         output: done.content.slice(-2000), isError: done.isError });
       settleResolve();
       const e = getEntry(id); if (e) notifyEntryCompletion(e);
     })().catch(() => { settleResolve(); });
     return { content: `Backgrounded as job ${id}; collect with hub {op:"output", id:"${id}"} or hub {op:"wait", ids:["${id}"]}.` };
   }
   ```
   （`runCell` 捕获 abort → 返回 isError，内容为 "eval error"；`killed/timedOut` 由闭包旗标裁定，不再恒 false。原 `defaultEvalTimeoutMs` 若不存在就用 `(input.timeout ?? 0)`——以文件实际解析为准，保持 timeout:0=无死线。）
5. 删 schema 中 `jobAction`/`jobId`；删 execute 的 jobAction 分支。
6. 删文件尾 `countRunningEvalJobs`。

### 2c. 删除 `src/core/tools/bg-jobs.ts`

### 2d. `src/modes/tui/tui-render.ts`

- 删第 16/17 行 import（countRunningBashJobs/countRunningEvalJobs），加
  ```ts
  import { countRunningJobs } from "../../core/coordination/registry.js";
  ```
- 第 429 行 `const runningBg = countRunningBashJobs() + countRunningEvalJobs();` → `const runningBg = countRunningJobs();`

### 2e. 测试更新

- `bash.test.ts`：删除 `jobAction=list with no jobs`、`async=true backgrounds a job; output pollable via jobAction`、`background job timeout kills the job (M-bash)`（超时测试改为轮询 getEntry 状态）、`unknown jobId errors` 四个用例，替换为：
  ```ts
  test("async=true registers a coordination entry and notifies on completion", async () => {
    const completions: string[] = [];
    setEntryCompletionListener((e) => completions.push(e.id));
    const result = await bashTool.execute({ description: "d", command: "echo hi", async: true });
    const id = /bg_\d+/.exec(String((result as { content: string }).content))![0];
    const deadline = Date.now() + 2000;
    while (getEntry(id)?.status === "running" && Date.now() < deadline) await Bun.sleep(10);
    expect(getEntry(id)?.status).toBe("completed");
    expect(completions).toContain(id);
    setEntryCompletionListener(null);
  });
  ```
  保留 `bg job completion fires the settlement listener` 用例时改 import（bg-jobs → coordination registry 的 setEntryCompletionListener）。`countRunning` 相关如有断言改 countRunningJobs。
- `eval.test.ts`：同法替换 `jobAction=*` 用例（list/async poll/kill）为 getEntry + completion listener 断言；`timeout 0 lets a slow cell finish` 保留但加 `timedOut` 断言可选。
- 需要的新 import：`import { getEntry, registerEntry, setEntryCompletionListener } from "../coordination/registry.js";`（测试用），以及 `clearAll()` 在 afterEach。

**验证**：
```bash
cd apps/oh-my-agent && bun test src/core/tools src/core/coordination src/modes/tui/tui-render.test.ts 2>/dev/null || bun test src/core/tools src/core/coordination
```

---

## Step 3 — delegation 迁移 + tool 收敛

### 3a. `src/core/delegation/executor.ts`

1. import 区：删 `./registry.js` import，改为
   ```ts
   import {
     appendEntryPartial, getEntry, listEntries, notifyEntryCompletion,
     registerEntry, updateEntry, clearScope,
   } from "../coordination/registry.js";
   ```
2. `DelegationExecutorOptions` 加 `readonly scope: string;`。
3. `runSubagent`：
   - resume 查找 `getSubagent(input.resumeHandle)` → `getEntry(input.resumeHandle)`（校验 `kind === "subagent"`，否则返回 error "unknown subagent handle"）。
   - fresh dispatch 的注册改为：
     ```ts
     const { promise: settle, resolve: settleResolve } = Promise.withResolvers<void>();
     registerEntry({ id: handle, kind: "subagent", scope: opts.scope, label: spec.label ?? agentId,
       startedAt: Date.now(), status: "running", finishedAt: null, partialText: "",
       settle, spec, store, sessionId, batchId, agentId });
     ```
   - 事件转发分支 `appendSubagentPartial(handle, ev.text)` → `appendEntryPartial(handle, ev.text)`。
4. `finish()` 终态写回（stopRequested 判定不变，函数换）：
   ```ts
   const entry = getEntry(handle);
   if (entry && entry.status !== "stopped") {
     const stopped = entry.stopRequested === true;
     updateEntry(handle, {
       status: stopped ? "stopped" : agentResult.ok ? "completed" : "failed",
       finishedAt: Date.now(),
       result: stopped ? { ...agentResult, ok: false, error: "stopped", status: "stopped" }
                      : { ...agentResult, status: agentResult.ok ? "completed" : "failed" },
     });
   }
   settleResolve();
   const finalEntry = getEntry(handle); if (finalEntry) notifyEntryCompletion(finalEntry);
   ```
   background `.then`/`.catch` 同样改 `getEntry/updateEntry`，并在写入后 `notifyEntryCompletion(getEntry(handle)!)`。
5. 控制面：
   - `listSubagents()` 改 `listEntries(opts.scope).filter((r) => r.kind === "subagent")`（返回 shape 兼容 hub 使用：含 partialText）。
   - `getSubagentOutput(handle)` 改 `getEntry(handle)`（spill 逻辑保留，用 entry.batchId / entry.result）。
   - `stopSubagent` / `steerSubagent` / `stopLiveSubagents` 的 `getSubagent` 换 `getEntry`；`updateSubagentStatus` 换 `updateEntry`。
   - `stopLiveSubagents` 结尾加 `liveSessions.clear()`（已有）不变。
6. `createDelegationExecutor` 内不再有 `clearScope` 使用（`close()` 由 run-runtime 调 stopLiveSubagents；registry 跨 Run 保留）。

### 3b. 删除 `src/core/delegation/registry.ts` 与 `src/core/delegation/registry.test.ts`

### 3c. `src/core/delegation/tool.ts` 收敛

删除 `task_list/task_output/task_steer/task_stop` 四个工具与 deps 对应字段；`DelegationToolDeps` 只剩 `runBatch/runSubagent/readAgentDefinition`；返回 `[task]`。task description 里 "poll via task_output, steer via task_steer" → "poll/wait/steer via hub"。工具描述 batch/single 其余不变。

### 3d. 测试更新

- `executor-subagent.test.ts`：import 改 `clearAll` from coordination（afterEach 调 `clearAll()`）；`makeDeps()` fixture 加 `scope: "test"`（executor.fixture.ts 的 makeDeps 返回对象加 `scope: "test"`）；所有 `getSubagentOutput` 断言不变（函数保留）；`clearSubagents` 相关 import 删除。
- `executor.fixture.ts`：makeDeps 加 `scope: "test"`。
- `tool.test.ts` 重写：只测 `task` 的 batch/single/resume/validation（删 4 个控制面工具断言与 task_list/task_output/task_steer/task_stop 的 find）；deps 只有 runBatch/runSubagent/readAgentDefinition。

**验证**：
```bash
cd apps/oh-my-agent && bun test src/core/delegation src/core/orchestrate
```

---

## Step 4 — hub-tool + run-runtime 接线

### 4a. 新建 `apps/oh-my-agent/src/core/coordination/hub-tool.ts`

```ts
import type { PluginTool } from "../agent-runtime.js";
import type { EntryRow, RegistryEntry } from "./registry.js";

export interface HubToolDeps {
  readonly scope: string;
  readonly list: (scope: string) => EntryRow[];
  readonly get: (id: string) => RegistryEntry | undefined;
  readonly wait: (opts: {
    ids?: readonly string[];
    scope: string;
    timeoutMs: number;
  }) => Promise<{ settled: EntryRow[]; timedOut: boolean }>;
  readonly stop: (id: string) => { ok: boolean; error?: string };
  readonly steer: (handle: string, prompt: string) => { ok: boolean; error?: string };
}

export function createHubTool(deps: HubToolDeps): readonly PluginTool[] {
  const hub: PluginTool = {
    name: "hub",
    description:
      "Unified coordination for background work. jobs: snapshot of all background " +
      "bash/eval jobs and task subagents (id, kind, status, label, partial). output: " +
      "fetch one entry by id (streaming partialText while running, final result when " +
      "settled). wait: block until the given ids (default: all running) settle or " +
      "timeoutMs (0 = indefinite) elapses. steer: inject a message into a RUNNING " +
      "subagent. stop: kill a bash/eval job or stop a subagent.",
    executionMode: "serial",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["jobs", "output", "wait", "steer", "stop"] },
        id: { type: "string" },
        ids: { type: "array", items: { type: "string" } },
        prompt: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["op"],
    },
    async execute(args) {
      const op = typeof args.op === "string" ? args.op : "";
      const id = typeof args.id === "string" ? args.id.trim() : "";
      const ids = Array.isArray(args.ids)
        ? (args.ids as unknown[]).filter((v): v is string => typeof v === "string")
        : undefined;
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 60_000;
      switch (op) {
        case "jobs":
          return { items: deps.list(deps.scope) };
        case "output": {
          if (!id) return { ok: false, error: "id is required" };
          const e = deps.get(id);
          if (!e) return { ok: false, error: `unknown id "${id}"` };
          return {
            id: e.id,
            kind: e.kind,
            status: e.status,
            label: e.label,
            ...(e.partialText ? { partialText: e.partialText } : {}),
            ...(e.output !== undefined ? { output: e.output } : {}),
            ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
            ...(e.isError !== undefined ? { isError: e.isError } : {}),
            ...(e.result ? { result: e.result } : {}),
          };
        }
        case "wait": {
          const out = await deps.wait({ ids, scope: deps.scope, timeoutMs });
          return { waited: out.settled, timedOut: out.timedOut };
        }
        case "steer": {
          if (!id) return { ok: false, error: "id is required" };
          if (!prompt) return { ok: false, error: "prompt is required" };
          return deps.steer(id, prompt);
        }
        case "stop": {
          if (!id) return { ok: false, error: "id is required" };
          return deps.stop(id);
        }
        default:
          return { ok: false, error: `unknown op "${op}" (jobs|output|wait|steer|stop)` };
      }
    },
  };
  return [hub];
}
```

### 4b. 新建 `apps/oh-my-agent/src/core/coordination/hub-tool.test.ts`

用桩 deps 测：jobs 透传、output 校验（缺 id/未知 id）、steer 校验（缺 prompt）、stop 透传、wait 透传、unknown op。全桩，无 registry 依赖。

### 4c. 新建 `apps/oh-my-agent/src/core/coordination/index.ts`

```ts
export * from "./registry.js";
export { createHubTool, type HubToolDeps } from "./hub-tool.js";
```

### 4d. `src/core/runtime/run-runtime.ts`

1. import 加：
   ```ts
   import { createHubTool, getEntry, listEntries, stopEntry, waitEntries } from "../coordination/index.js";
   ```
2. `RunRuntimeDeps` 加 `readonly coordinationScope?: string;`。
3. 组装处（`const mounted = await mountWorkspaceMcpServers(...)` 附近）加 `const scope = deps.coordinationScope ?? deps.runId;`
4. `createBashTool(bashToolOpts)` → `createBashTool({ ...bashToolOpts, scope })`；`createEvalTool({ workspaceRoot: deps.workspaceRoot })` → `createEvalTool({ workspaceRoot: deps.workspaceRoot, scope })`；`createDelegationExecutor({ ... })` 加 `scope,`。
5. delegation plugins 块：`createDelegationTools({...})` 只传 `runBatch/runSubagent/readAgentDefinition`（删 4 个控制面字段）。
6. 在 orchestrate plugins 块后加：
   ```ts
   plugins.push({
     name: "hub-tool",
     tools: createHubTool({
       scope,
       list: (s) => listEntries(s),
       get: (id) => getEntry(id),
       wait: (o) => waitEntries(o),
       stop: (id) => {
         const e = getEntry(id);
         if (e?.kind === "subagent") return delegationExecutor.stopSubagent(id);
         return stopEntry(id);
       },
       steer: (h, p) => delegationExecutor.steerSubagent(h, p),
     }),
   });
   ```
7. `close()` 不变。

**验证**：
```bash
cd apps/oh-my-agent && bun test src/core/coordination src/core/delegation src/core/orchestrate src/core/runtime/create-runtime.test.ts src/core/runtime/create-runtime-workflow.test.ts && bun run typecheck
```

---

## Step 5 — TUI

### 5a. `src/modes/tui/tui-mode.ts`

模块顶部（import 后）加：
```ts
/** One interactive TUI session per process; coordination scope stays stable
 *  across Runs so subagent handles survive follow-ups in this process. */
const COORDINATION_SCOPE = `tui-${process.pid}`;
```
`createOmaRuntime({...})` 调用加 `coordinationScope: COORDINATION_SCOPE,`。

### 5b. `src/modes/tui/tui-io.ts`

- 删 `import { setBgJobCompletionListener } from "../../core/tools/bg-jobs.js";`，加
  ```ts
  import { setEntryCompletionListener } from "../../core/coordination/registry.js";
  ```
- 把 `setBgJobCompletionListener((c) => {...})` 整体替换为：
  ```ts
  setEntryCompletionListener((e) => {
    const text =
      e.kind === "subagent"
        ? `${e.id} (${e.label}) ${e.status === "completed" ? "ok" : e.status}${e.result?.text ? `\n${e.result.text.trim().slice(0, 400)}` : ""}`
        : `${e.id} (${e.kind}) ${
            e.killed ? "killed" : e.timedOut ? "timed out" : e.exitCode === null || e.exitCode === undefined ? "finished" : `exit ${e.exitCode}`
          }${e.output?.trim() ? `\n${e.output.trim().slice(0, 2000)}` : ""}`;
    bgPending.push(text);
    if (bgDebounce) clearTimeout(bgDebounce);
    if (process.env.OMA_BG_INJECT === "0") {
      shell.appendNotice(bgPending.join("\n\n"));
      bgPending.length = 0;
      return;
    }
    bgDebounce = setTimeout(() => {
      const joined = bgPending.join("\n\n---\n\n");
      bgPending.length = 0;
      if (joined) injectUserMessage(`[background work finished]\n${joined}`);
    }, 1_500);
    bgDebounce.unref?.();
  });
  ```

### 5c. `src/modes/tui/tui-render.ts`

`renderTool` 里 `if (toolName === "task" || toolName === "task_list" || toolName === "task_output")` 改为：
```ts
    if (toolName === "task") {
      return renderTaskTool(item, expanded);
    }
    if (toolName === "hub") {
      return renderHubTool(item, expanded);
    }
```
import 加 `renderHubTool`。

### 5d. `src/modes/tui/tui-tool-render.ts`

- `renderTaskTool` 删除 `task_list`/`task_output` 两个分支（保留 batch/single 渲染与 streaming 尾），title 简化为 `task` + label。
- 新增 `renderHubTool`：

```ts
/** hub 工具块：jobs/output/wait/steer/stop 的纯文本渲染。 */
export function renderHubTool(item: TranscriptItem, expanded: boolean): string[] {
  const lines: string[] = ["\u001b[36m  hub\u001b[0m"];
  const input = item.input as Record<string, unknown> | undefined;
  const op = typeof input?.op === "string" ? input.op : "";
  const result = item.result as Record<string, unknown> | undefined;
  const rows = (v: unknown): Array<Record<string, unknown>> =>
    Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
  if (op === "jobs" || op === "wait") {
    const items = rows(result?.items ?? result?.waited);
    if (items.length === 0) {
      lines.push(
        op === "wait"
          ? `\u001b[2m    ${result?.timedOut ? "timed out" : "nothing to wait for"}\u001b[0m`
          : "\u001b[2m    (no background work)\u001b[0m",
      );
    }
    for (const r of items) {
      const mark = r.status === "running" ? "\u27f3" : r.status === "failed" || r.status === "stopped" ? "\u2718" : "\u2714";
      lines.push(`\u001b[2m  ${mark} ${String(r.id)} (${String(r.kind)}) [${String(r.status)}] ${String(r.label ?? "").slice(0, 60)}\u001b[0m`);
      const partial = typeof r.partialText === "string" && r.partialText.trim() ? r.partialText.trim() : "";
      if (partial) lines.push(`\u001b[2m    ${partial.slice(0, expanded ? 400 : 120)}\u001b[0m`);
    }
    return lines;
  }
  if (op === "output") {
    const status = String(result?.status ?? "");
    if (status) lines.push(`\u001b[2m    status: ${status}\u001b[0m`);
    const partial = typeof result?.partialText === "string" ? result.partialText : "";
    if (partial.trim()) lines.push(`\u001b[2m    ${partial.trim().slice(0, expanded ? 400 : 160)}\u001b[0m`);
    const nested = result?.result;
    if (nested && typeof nested === "object") {
      const text = String((nested as Record<string, unknown>).text ?? "");
      if (text.trim()) lines.push(`\u001b[2m    ${text.trim().slice(0, expanded ? 400 : 160)}\u001b[0m`);
    }
    if (lines.length === 1) lines.push("\u001b[2m    (unknown id)\u001b[0m");
    return lines;
  }
  // steer / stop: { ok, error? }
  const ok = result?.ok;
  if (result) {
    lines.push(ok === false ? `\u001b[31m    ${String(result.error ?? "failed")}\u001b[0m` : "\u001b[2m    ok\u001b[0m");
  } else if (item.streaming) {
    lines.push("\u001b[2m    \u27f3 waiting…\u001b[0m");
  }
  return lines;
}
```

### 5e. 测试

- `tui-mode.test.ts`：hub 渲染断言（applyEvent 无关；直接测 `renderHubTool` 纯函数：jobs 行、output partial、wait timedOut、steer error）——放新文件 `src/modes/tui/tui-tool-render.test.ts`（若不存在则新建）。

**验证**：
```bash
cd apps/oh-my-agent && bun test src/modes/tui && bun run typecheck
```

---

## Step 6 — 全量验证

```bash
cd /root/my-agent-team/apps/oh-my-agent && bun run typecheck && bun test && bun run build
cd ../backend && bun run typecheck && bun test
cd ../web && bun run typecheck
grep -rn "task_list\|task_output\|task_steer\|task_stop\|jobAction\|bg-jobs" apps/oh-my-agent/src --include="*.ts" | grep -v dist
# 必须为空（除历史注释）——spec/plan 文档与 dist 除外
```

CI 会跑 `bun run audit`（typedSource/契约/文档门禁）：本改动无新事件、无新路由，audit 应绿；若文档门禁扫到 AGENTS.md 提及 task_list，需同步 AGENTS.md。

---

## 提交（4 笔，HUSKY=0，按路径 add）

1. `feat(oh-my-agent): add coordination registry for background jobs and subagents`
   `git add apps/oh-my-agent/src/core/coordination/registry.ts apps/oh-my-agent/src/core/coordination/registry.test.ts`
2. `refactor(oh-my-agent): migrate bash and eval background jobs onto the coordination registry`
   `git add apps/oh-my-agent/src/core/tools/bash.ts apps/oh-my-agent/src/core/tools/eval.ts apps/oh-my-agent/src/core/tools/bash.test.ts apps/oh-my-agent/src/core/tools/eval.test.ts apps/oh-my-agent/src/modes/tui/tui-render.ts` + 删除 `apps/oh-my-agent/src/core/tools/bg-jobs.ts`
3. `feat(oh-my-agent): unify delegation control plane into the hub tool`
   `git add apps/oh-my-agent/src/core/delegation apps/oh-my-agent/src/core/coordination apps/oh-my-agent/src/core/runtime/run-runtime.ts` + 删除 `apps/oh-my-agent/src/core/delegation/registry.ts apps/oh-my-agent/src/core/delegation/registry.test.ts`
4. `feat(oh-my-agent): render hub ops and unify completion injection in the TUI`
   `git add apps/oh-my-agent/src/modes/tui`

---

## 风险清单（执行前读三遍）

1. `delegation/executor.ts` 与 `coordination/registry.ts` 的 type-only 循环 import 是安全的（type import 运行时擦除）；**不要**在 registry.ts 里 runtime import executor。
2. bash `startJob` 里 `kill` 闭包引用 `job`（TDZ）：`const job` 必须先于 `registerEntry({... kill: () => {... job ...}})` 定义；调用发生在运行时，TS 通过。
3. `settle` promise 三条路径（bash exited、bash catch、eval 完成）都要 `resolve`，否则 `hub wait` 挂起——每个路径配断言。
4. `stopEntry` 对 subagent 只置 `stopRequested`；真正 `session.stop()` 走 `delegationExecutor.stopSubagent`（run-runtime 的 hub stop 接线已分流）。
5. `executor-subagent.test.ts` 的 `afterEach` 必须 `clearAll()`（registry 是模块级单例，测试间泄漏会互相污染）。
6. eval 的 `timeout` 解析保持现状（`timeout: 0` = 无死线）；不确定处照抄原文件逻辑，不要发明新默认值。
7. bash/eval 完成后 `updateEntry` 的 `output` 只存尾截（bash `-2000`，eval `-2000`），完整输出仍由工具前台路径返回。
