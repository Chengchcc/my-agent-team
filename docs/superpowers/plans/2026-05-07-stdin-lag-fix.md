# 修复 stdin 卡顿 — 完整计划

> **根因:** zustand `textDelta` 同步触发 3 个直接订阅 `s.live` 的组件重渲染。每次 delta 都导致 `ActiveAssistantView` 整棵子树 reconcile + Ink 同步写 ANSI。Committer 的 33ms 节流和 setImmediate 推迟完全被绕过。

---

## Task 1: `useLiveItem` 改为结构级订阅

**Files:**
- Modify: `src/cli/tui/state/store.ts:319-321`

**问题:** `useLiveItem()` 返回 `s.live`。每次 `textDelta` → immer 修改 `live.segments[i].content` → `s.live` 引用变化 → `Object.is` 失败 → `App.tsx` 重渲染 → `toActiveAssistant` 创建新对象 → `ActiveAssistantView` 子树 reconcile → Ink stdout.write。

`LiveTextSegment` 内部用 `useSegmentFrame`（已节流）取文本，外层不需要为文本变化重渲染。

**修复:** 用 `useStore` + 自定义 `equals` 函数，只在结构变化时通知：

```ts
import { useStore } from 'zustand';

function liveStructureEquals(a: FinalItem | null, b: FinalItem | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind !== 'assistant-message' || b.kind !== 'assistant-message') {
    return a.id === b.id;
  }
  if (a.id !== b.id || a.status !== b.status) return false;
  if (a.segments.length !== b.segments.length) return false;
  for (let i = 0; i < a.segments.length; i++) {
    const sa = a.segments[i]!;
    const sb = b.segments[i]!;
    if (sa.kind !== sb.kind || sa.id !== sb.id) return false;
    if (sa.kind === 'tool_call' && sb.kind === 'tool_call') {
      if (sa.name !== sb.name) return false;
      if (!!sa.result !== !!sb.result) return false;
    }
    // text segment: 忽略 content/committedLength 变化
  }
  return true;
}

export function useLiveItem(): FinalItem | null {
  return useStore(useTuiStore, (s) => s.live, liveStructureEquals);
}
```

**验证:** `bun test tests/tui/committer.test.ts` 应全通过。

---

## Task 2: `FocusedToolDetail` 取消 `s.live` 订阅

**Files:**
- Modify: `src/cli/tui/views/overlay/FocusedToolDetail.tsx:10`

**问题:** `const live = useTuiStore(s => s.live)` 每次 delta 触发该组件重渲染，即使没有 focus 任何 tool。

**修复:** 用 `getState()` 命令式读取，仅在 `focusedId` 变化时重渲染：

```tsx
export function FocusedToolDetail() {
  const focusedId = useTuiStore(s => s.interaction.focusedToolId);
  if (!focusedId) return null;

  // 命令式读取，不订阅 — 仅 focusedId 变化时重渲染
  const { live, finalized } = useTuiStore.getState();
  // ... 剩余逻辑不变
}
```

---

## Task 3: `App.tsx` — memo `toActiveAssistant`

**Files:**
- Modify: `src/cli/tui/App.tsx`

**问题:** `toActiveAssistant(liveItem)` 在 App 每次渲染时创建新 `CompatActiveAssistant` 对象，即使 `liveItem` 没变，`ActiveAssistantView` 的 props 也是新引用（但 Task 1 已解决 `liveItem` 不必要变化）。

**修复:** `toActiveAssistant` 调用结果用 `useMemo` 包裹，依赖 `liveItem` 结构键：

```tsx
const liveItem = useLiveItem();
const activeAssistant = useMemo(
  () => liveItem?.kind === 'assistant-message' ? toActiveAssistant(liveItem) : null,
  [liveItem],
);
```

然后渲染处用 `activeAssistant` 替代 `toActiveAssistant(liveItem)`。

---

## Task 4: 验证

- [ ] `bun test` — 全量测试通过
- [ ] `bun run tui -- --debug --debug-file /tmp/perf-final.log` — 流式 markdown 时输入不再卡顿
- [ ] debug log 确认 `COMMITTER timing` 频率按 33ms 节律，不再被 zustand 直接订阅触发额外渲染

---

## 变更文件总览

| 文件 | 变更 |
|------|------|
| `src/cli/tui/state/store.ts` | `useLiveItem` 改为 `useStore` + 结构级相等函数 |
| `src/cli/tui/views/overlay/FocusedToolDetail.tsx` | `useTuiStore(s => s.live)` 改为 `getState()` |
| `src/cli/tui/App.tsx` | `toActiveAssistant` 加 `useMemo` |
