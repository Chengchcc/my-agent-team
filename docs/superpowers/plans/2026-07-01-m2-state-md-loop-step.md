# M2 STATE.md I/O + loopStep — 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 `packages/loop/` 上加文件读写层——`state-md.ts` 四个解析/格式化纯函数 + `loop-step.ts` 读文件→调 reducer→写回。

**Architecture:** state-md.ts 纯函数（字符串 ←→ LoopState），loop-step.ts 用 `Bun.file()` 读/写 STATE.md 和 INBOX.md。loopStep() 不调 AgentSession，TICK 后 item 停在 fixing。

**Tech Stack:** TypeScript, Bun.file(), bun:test

**Reference:** `docs/superpowers/specs/2026-07-01-m2-state-md-loop-step.md`

---

### Task 1: state-md.ts — 解析与格式化

**Files:**
- Create: `packages/loop/src/state-md.ts`

- [ ] **Step 1.1: 写 YAML 序列化/反序列化辅助**

```typescript
// 手写轻量 YAML（两层嵌套：result + reasons 数组）
// 不引入第三方 YAML 库

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

function yamlParseBlock(lines: string[]): Record<string, YamlValue>;
function yamlFormatValue(value: YamlValue, indent: number): string;
```

解析算法：
- 逐行扫描，按缩进层级建树
- `key: value` → 顶层字段（value 可以是 string/number/boolean/null）
- `key:` → 开始嵌套对象，下行缩进 +2 的字段属于该对象
- `  - item` → 数组元素

序列化算法：
- `result: null` → 不输出此行
- `verdict: PASS` → 直接输出
- `reasons:` 后每行 `  - reason` 缩进输出

- [ ] **Step 1.2: 写 parseStateMd**

```typescript
import type { LoopState, ItemState } from "./types.js";

export function parseStateMd(md: string): LoopState {
  if (!md.trim()) {
    return { loopId: "", lastRun: null, items: {} };
  }

  // 1. 提取 frontmatter（第一个 --- 到第二个 ---）
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = fmMatch ? yamlParseBlock(fmMatch[1].split("\n")) : {};

  // 2. 找 ## Items 后的所有 ### <id> sections
  const itemsMatch = md.match(/## Items\n([\s\S]*)$/);
  const items: LoopState["items"] = {};

  if (itemsMatch) {
    const sections = itemsMatch[1].split(/(?=### )/);
    for (const section of sections) {
      const idMatch = section.match(/### (\S+)/);
      if (!idMatch) continue;
      const id = idMatch[1]!;
      const lines = section.split("\n").slice(1); // skip ### line
      const data = yamlParseBlock(lines);
      items[id] = yamlToItemState(id, data);
    }
  }

  return {
    loopId: String(frontmatter.loopId ?? ""),
    lastRun: frontmatter.lastRun ? String(frontmatter.lastRun) : null,
    items,
  };
}
```

- [ ] **Step 1.3: 写 formatStateMd**

```typescript
export function formatStateMd(state: LoopState): string {
  // 1. Frontmatter
  let md = "---\n";
  md += `loopId: ${state.loopId}\n`;
  if (state.lastRun) md += `lastRun: ${state.lastRun}\n`;
  md += "version: 1\n";
  md += "---\n\n";
  md += "# Loop State\n\n";
  md += "## Items\n\n";

  // 2. Items
  for (const item of Object.values(state.items)) {
    md += `### ${item.id}\n`;
    md += itemStateToYaml(item);
    md += "\n";
  }

  return md;
}

function itemStateToYaml(item: ItemState): string {
  let y = `source: ${item.source}\n`;
  y += `summary: ${item.summary}\n`;
  y += `step: ${item.step}\n`;
  y += `attempt: ${item.attempt}\n`;
  y += `priority: ${item.priority}\n`;
  if (item.result !== null) {
    y += `result:\n`;
    y += formatVerdict(item.result, 1);
  }
  return y;
}

function formatVerdict(v: Verdict, depth: number): string {
  const indent = "  ".repeat(depth);
  let y = `${indent}verdict: ${v.verdict}\n`;
  if ("reasons" in v && v.reasons.length > 0) {
    y += `${indent}reasons:\n`;
    for (const r of v.reasons) {
      y += `${indent}  - ${r}\n`;
    }
  }
  y += `${indent}evidence: "${v.evidence}"\n`;
  return y;
}
```

- [ ] **Step 1.4: 写 yamlToItemState 辅助**

```typescript
function yamlToItemState(id: string, data: Record<string, YamlValue>): ItemState {
  return {
    id,
    source: String(data.source ?? ""),
    summary: String(data.summary ?? ""),
    step: (String(data.step ?? "triaged")) as ItemStep,
    attempt: Number(data.attempt ?? 1),
    priority: Number(data.priority ?? 0),
    result: data.result && typeof data.result === "object"
      ? yamlToVerdict(data.result as Record<string, YamlValue>)
      : null,
  };
}

function yamlToVerdict(data: Record<string, YamlValue>): Verdict {
  const verdict = String(data.verdict ?? "ESCALATE") as Verdict["verdict"];
  const evidence = String(data.evidence ?? "");
  const reasons = Array.isArray(data.reasons)
    ? data.reasons.map(String)
    : [];
  if (verdict === "PASS") return { verdict, evidence };
  return { verdict, reasons, evidence } as Verdict;
}
```

- [ ] **Step 1.5: 写 parseInboxMd + formatInboxMd**

```typescript
export function parseInboxMd(md: string): LoopState["items"] {
  if (!md.trim()) return {};
  const items: LoopState["items"] = {};
  // 同 parseStateMd 的 section 解析，不用找 frontmatter
  const sections = md.split(/(?=### )/);
  for (const section of sections) {
    const idMatch = section.match(/### (\S+)/);
    if (!idMatch) continue;
    const id = idMatch[1]!;
    const lines = section.split("\n").slice(1);
    const data = yamlParseBlock(lines);
    items[id] = yamlToItemState(id, data);
  }
  return items;
}

export function formatInboxMd(items: LoopState["items"]): string {
  let md = "";
  for (const item of Object.values(items)) {
    md += `### ${item.id}\n`;
    md += itemStateToYaml(item);
    md += "\n";
  }
  return md;
}
```

- [ ] **Step 1.6: Verify typecheck**

```bash
cd packages/loop && bun run typecheck
```

- [ ] **Step 1.7: Commit**

```bash
git add packages/loop/src/state-md.ts && git commit -m "feat(loop): add state-md parse/format for STATE.md and INBOX.md"
```

---

### Task 2: state-md.test.ts — 解析/格式化测试

**Files:**
- Create: `packages/loop/src/state-md.test.ts`

- [ ] **Step 2.1: 写测试——空状态**

```typescript
import { describe, test, expect } from "bun:test";
import { parseStateMd, formatStateMd, parseInboxMd, formatInboxMd } from "./state-md.js";
import type { LoopState } from "./types.js";

function sampleState(): LoopState {
  return {
    loopId: "test-loop",
    lastRun: "2026-07-01T08:00:00Z",
    items: {
      "01": {
        id: "01", source: "ci/4821", summary: "auth flaky",
        step: "verifying", attempt: 1, priority: 0, result: null,
      },
      "02": {
        id: "02", source: "issue/92", summary: "parser null",
        step: "fixing", attempt: 2, priority: 0,
        result: { verdict: "REJECT", reasons: ["scope drift"], evidence: "touched 5 files" },
      },
    },
  };
}

describe("parseStateMd", () => {
  test("empty string → empty state", () => {
    const s = parseStateMd("");
    expect(s.loopId).toBe("");
    expect(s.lastRun).toBeNull();
    expect(s.items).toEqual({});
  });

  test("round-trip: format → parse → equivalent", () => {
    const s = sampleState();
    const md = formatStateMd(s);
    const parsed = parseStateMd(md);
    expect(parsed.loopId).toBe(s.loopId);
    expect(parsed.lastRun).toBe(s.lastRun);
    expect(Object.keys(parsed.items)).toEqual(Object.keys(s.items));
    for (const id of Object.keys(s.items)) {
      expect(parsed.items[id]!.step).toBe(s.items[id]!.step);
      expect(parsed.items[id]!.attempt).toBe(s.items[id]!.attempt);
      expect(parsed.items[id]!.summary).toBe(s.items[id]!.summary);
    }
  });

  test("null result → no result line in markdown", () => {
    const s = sampleState();
    const md = formatStateMd(s);
    // item 01 has null result — "result:" should not appear in its section
    const section01 = md.split("### 01")[1]?.split("### ")[0] ?? "";
    expect(section01).not.toContain("result:");
  });

  test("REJECT result → round-trip preserves reasons", () => {
    const s = sampleState();
    const md = formatStateMd(s);
    const parsed = parseStateMd(md);
    const result = parsed.items["02"]!.result;
    expect(result).not.toBeNull();
    if (result && "reasons" in result) {
      expect(result.reasons).toEqual(["scope drift"]);
    }
  });
});

describe("parseInboxMd / formatInboxMd", () => {
  test("empty string → empty inbox", () => {
    const items = parseInboxMd("");
    expect(items).toEqual({});
  });

  test("round-trip inbox", () => {
    const items = {
      "99": {
        id: "99", source: "manual", summary: "dismissed item",
        step: "inbox" as const, attempt: 2, priority: 0,
        result: { verdict: "REJECT" as const, reasons: ["手动驳回"], evidence: "" },
      },
    };
    const md = formatInboxMd(items);
    const parsed = parseInboxMd(md);
    expect(Object.keys(parsed)).toEqual(["99"]);
    expect(parsed["99"]!.step).toBe("inbox");
  });
});
```

- [ ] **Step 2.2: Run tests**

```bash
cd packages/loop && bun test --test-name-pattern="state-md"
```

Expected: PASS

- [ ] **Step 2.3: Commit**

```bash
git add packages/loop/src/state-md.test.ts && git commit -m "test(loop): add state-md parse/format round-trip tests"
```

---

### Task 3: loop-step.ts — 编排函数

**Files:**
- Create: `packages/loop/src/loop-step.ts`

- [ ] **Step 3.1: 写 loopStep**

```typescript
import type { LoopState, LoopAction } from "./types.js";
import { loopReducer } from "./loop-reducer.js";
import { parseStateMd, formatStateMd, parseInboxMd, formatInboxMd } from "./state-md.js";

type ReviewAction = {
  itemId: string;
  verdict: "approve" | "reject" | "promote" | "retry" | "dismiss";
  feedback?: string;
};

function actionVerdictToLoopAction(action: ReviewAction): LoopAction {
  switch (action.verdict) {
    case "approve": return { type: "APPROVE", itemId: action.itemId };
    case "reject": return { type: "REJECT_HUMAN", itemId: action.itemId, feedback: action.feedback };
    case "promote": return { type: "PROMOTE", itemId: action.itemId };
    case "retry": return { type: "RETRY", itemId: action.itemId };
    case "dismiss": return { type: "DISMISS", itemId: action.itemId };
  }
}

function pruneTerminal(items: LoopState["items"]): LoopState["items"] {
  const result: LoopState["items"] = {};
  for (const [id, item] of Object.entries(items)) {
    if (item.step !== "resolved" && item.step !== "promoted") {
      result[id] = item;
    }
  }
  return result;
}

export async function loopStep(params: {
  loopConfigPath: string;
  action?: ReviewAction;
}): Promise<LoopState> {
  const statePath = `${params.loopConfigPath}/STATE.md`;
  const inboxPath = `${params.loopConfigPath}/INBOX.md`;

  // 1. Read files
  let stateMd: string;
  let inboxMd: string;
  try {
    stateMd = await Bun.file(statePath).text();
  } catch {
    stateMd = "";
  }
  try {
    inboxMd = await Bun.file(inboxPath).text();
  } catch {
    inboxMd = "";
  }

  let state = parseStateMd(stateMd);
  let inboxItems = parseInboxMd(inboxMd);

  // 2. Action or TICK
  if (params.action) {
    const action = params.action;

    if (action.verdict === "retry") {
      // Move from INBOX → STATE, then TICK
      const item = inboxItems[action.itemId];
      if (item) {
        state = loopReducer(state, { type: "ADD_ITEM", item: { id: item.id, source: item.source, summary: item.summary } });
        state = loopReducer(state, { type: "TICK" });
        delete inboxItems[action.itemId];
      }
    } else if (action.verdict === "dismiss") {
      // Remove from INBOX
      delete inboxItems[action.itemId];
    } else {
      // APPROVE / REJECT_HUMAN / PROMOTE — operate on STATE.md
      // Check if item is in inbox (rejected from review)
      if (!state.items[action.itemId] && inboxItems[action.itemId]) {
        // item is in inbox, operate on inbox state
        const inboxItem = inboxItems[action.itemId]!;
        state = loopReducer(
          { ...state, items: { ...state.items, [action.itemId]: inboxItem } },
          actionVerdictToLoopAction(action),
        );
      } else {
        state = loopReducer(state, actionVerdictToLoopAction(action));
      }
    }
  } else {
    // Cron TICK
    state = loopReducer(state, { type: "TICK" });
  }

  // 3. Extract inbox items and prune terminal items
  const newInboxItems: LoopState["items"] = {};
  const remainingItems: LoopState["items"] = {};

  for (const [id, item] of Object.entries(state.items)) {
    if (item.step === "inbox") {
      newInboxItems[id] = item;
    } else {
      remainingItems[id] = item;
    }
  }

  // Merge with existing inbox items that weren't touched
  const mergedInbox = { ...inboxItems, ...newInboxItems };
  const prunedItems = pruneTerminal(remainingItems);

  state = { ...state, items: prunedItems };

  // 4. Write back
  await Bun.write(statePath, formatStateMd(state));
  await Bun.write(inboxPath, formatInboxMd(mergedInbox));

  return state;
}
```

- [ ] **Step 3.2: Verify typecheck**

```bash
cd packages/loop && bun run typecheck
```

- [ ] **Step 3.3: Commit**

```bash
git add packages/loop/src/loop-step.ts && git commit -m "feat(loop): add loopStep for STATE.md/INBOX.md read-write orchestration"
```

---

### Task 4: loop-step.test.ts — 集成测试

**Files:**
- Create: `packages/loop/src/loop-step.test.ts`

- [ ] **Step 4.1: 写测试——TICK**

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { loopStep } from "./loop-step.js";
import { parseStateMd, formatStateMd, parseInboxMd } from "./state-md.js";
import { loopReducer } from "./loop-reducer.js";
import type { LoopState } from "./types.js";
import { mkdir, rm } from "node:fs/promises";

const TMP = "/tmp/loop-step-test";

async function initLoopDir(): Promise<string> {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  return TMP;
}

function emptyState(): LoopState {
  return { loopId: "test", lastRun: null, items: {} };
}

describe("loopStep — TICK", () => {
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("triaged → fixing, written to STATE.md", async () => {
    const dir = await initLoopDir();
    const state = loopReducer(emptyState(), { type: "ADD_ITEM", item: { id: "01", source: "ci", summary: "flaky" } });
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const next = await loopStep({ loopConfigPath: dir });

    expect(next.items["01"]!.step).toBe("fixing");
    // Verify written to disk
    const written = await Bun.file(`${dir}/STATE.md`).text();
    const parsed = parseStateMd(written);
    expect(parsed.items["01"]!.step).toBe("fixing");
  });

  test("empty STATE.md + TICK → unchanged", async () => {
    const dir = await initLoopDir();
    await Bun.write(`${dir}/STATE.md`, formatStateMd(emptyState()));

    const next = await loopStep({ loopConfigPath: dir });
    expect(next.items).toEqual({});
  });
});

describe("loopStep — APPROVE", () => {
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("awaiting_review → resolved (pruned after write)", async () => {
    const dir = await initLoopDir();
    let state = emptyState();
    state = loopReducer(state, { type: "ADD_ITEM", item: { id: "01", source: "ci", summary: "flaky" } });
    state = loopReducer(state, { type: "TICK" });
    state = loopReducer(state, { type: "GENERATOR_DONE", itemId: "01" });
    state = loopReducer(state, { type: "EVALUATOR_VERDICT", itemId: "01", verdict: { verdict: "PASS", evidence: "ok" } });
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const next = await loopStep({ loopConfigPath: dir, action: { itemId: "01", verdict: "approve" } });

    // Resolved items are pruned
    expect(next.items["01"]).toBeUndefined();
    // Verify disk
    const written = parseStateMd(await Bun.file(`${dir}/STATE.md`).text());
    expect(written.items["01"]).toBeUndefined();
  });
});

describe("loopStep — REJECT_HUMAN", () => {
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("awaiting_review → inbox in INBOX.md", async () => {
    const dir = await initLoopDir();
    let state = emptyState();
    state = loopReducer(state, { type: "ADD_ITEM", item: { id: "01", source: "ci", summary: "flaky" } });
    state = loopReducer(state, { type: "TICK" });
    state = loopReducer(state, { type: "GENERATOR_DONE", itemId: "01" });
    state = loopReducer(state, { type: "EVALUATOR_VERDICT", itemId: "01", verdict: { verdict: "PASS", evidence: "ok" } });
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const next = await loopStep({ loopConfigPath: dir, action: { itemId: "01", verdict: "reject", feedback: "wrong approach" } });

    expect(next.items["01"]).toBeUndefined(); // moved from STATE
    const inboxMd = await Bun.file(`${dir}/INBOX.md`).text();
    const inbox = parseInboxMd(inboxMd);
    expect(inbox["01"]!.step).toBe("inbox");
    expect(inbox["01"]!.result).not.toBeNull();
  });
});

describe("loopStep — RETRY", () => {
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("inbox → triaged → fixing in STATE.md, removed from INBOX.md", async () => {
    const dir = await initLoopDir();
    // Pre-populate INBOX.md with a rejected item
    const inboxItems = {
      "01": {
        id: "01", source: "ci", summary: "flaky",
        step: "inbox" as const, attempt: 3, priority: 0,
        result: { verdict: "REJECT" as const, reasons: ["bad"], evidence: "" },
      },
    };
    await Bun.write(`${dir}/INBOX.md`, formatInboxMd(inboxItems));

    const next = await loopStep({ loopConfigPath: dir, action: { itemId: "01", verdict: "retry" } });

    expect(next.items["01"]!.step).toBe("fixing");
    expect(next.items["01"]!.attempt).toBe(1);
    expect(next.items["01"]!.result).toBeNull();
    // INBOX.md should be empty
    const inboxMd = await Bun.file(`${dir}/INBOX.md`).text();
    const inbox = parseInboxMd(inboxMd);
    expect(inbox["01"]).toBeUndefined();
  });
});

describe("loopStep — DISMISS", () => {
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("inbox item removed from INBOX.md", async () => {
    const dir = await initLoopDir();
    const inboxItems = {
      "01": {
        id: "01", source: "ci", summary: "flaky",
        step: "inbox" as const, attempt: 3, priority: 0,
        result: { verdict: "REJECT" as const, reasons: ["bad"], evidence: "" },
      },
      "02": {
        id: "02", source: "manual", summary: "other",
        step: "inbox" as const, attempt: 1, priority: 0, result: null,
      },
    };
    await Bun.write(`${dir}/INBOX.md`, formatInboxMd(inboxItems));

    await loopStep({ loopConfigPath: dir, action: { itemId: "01", verdict: "dismiss" } });

    const inboxMd = await Bun.file(`${dir}/INBOX.md`).text();
    const inbox = parseInboxMd(inboxMd);
    expect(inbox["01"]).toBeUndefined();
    expect(inbox["02"]).toBeDefined();
  });
});

describe("loopStep — unknown itemId", () => {
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("action on unknown id → no-op, files unchanged", async () => {
    const dir = await initLoopDir();
    const state = emptyState();
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const next = await loopStep({ loopConfigPath: dir, action: { itemId: "nope", verdict: "approve" } });

    expect(next.items).toEqual({});
  });
});
```

- [ ] **Step 4.2: Run all tests**

```bash
cd packages/loop && bun test
```

Expected: all state-md tests + loop-step tests PASS.

- [ ] **Step 4.3: Commit**

```bash
git add packages/loop/src/loop-step.test.ts && git commit -m "test(loop): add loopStep integration tests with temp dir"
```

---

### Task 5: 更新 index.ts 导出

**Files:**
- Modify: `packages/loop/src/index.ts`

- [ ] **Step 5.1: 加导出**

```typescript
export type {
  ItemId,
  ItemStep,
  Verdict,
  ItemState,
  LoopState,
  LoopAction,
} from "./types.js";
export { loopReducer } from "./loop-reducer.js";
export {
  parseStateMd,
  formatStateMd,
  parseInboxMd,
  formatInboxMd,
} from "./state-md.js";
export { loopStep } from "./loop-step.js";
```

- [ ] **Step 5.2: Commit**

```bash
git add packages/loop/src/index.ts && git commit -m "feat(loop): export state-md and loopStep from barrel"
```

---

### Task 6: 全量验证

- [ ] **Step 6.1: Full workspace**

```bash
bun run typecheck && bun run lint && bun run test
```

- [ ] **Step 6.2: Commit**

```bash
git add -A && git commit -m "chore(loop): full workspace typecheck, lint, test after M2"
```
