# TUI Claude-Code 对齐与视觉提级

> **Status**: v3 (post-grilling, ready for planning)
> **Predecessors**: TUI wiring + M3 follow-up (commits `c143846` → `f8b4cae`)
> **Scope**: 统一键路由根治多 useInput 冲突 + 对齐 Claude Code 标志性交互模式 + 收掉一批高 ROI 视觉问题 + Edit/Write 工具拆分 + 权限 overlay diff 预览。
> **Estimated LOC**: ~1780（含测试）
> **PRs**: 10
> **Grilling**: 14 rounds (Q1–Q14), decisions captured inline.
> **Last revised**: 4 corrections + 2 enhancements applied (post-grilling review).

---

## 0. 范围一图

```
┌─ Group A: 架构基座 ──────────────────────────────────┐
│  A-1 KeyDispatcher 升级 (priority + when)             │
│  A-2 Ink 输入规范化 (normalizeKey)                     │
│  A-3 分层 keymap 集中 (global/input/picker 三表)      │
└──────────────────────────────────────────────────────┘
                          ↓
┌─ Group K: KeyMap 对齐 ───────────────────────────────┐
│  K-1 词/行光标跳转  K-2 双击 Ctrl+C 退出              │
│  K-3 → V-1.b: footer hint 由 keymap 表驱动           │
└──────────────────────────────────────────────────────┘
                          ↓
┌─ Group T: 工具拆分与 diff 激活 ──────────────────────┐
│  T-1 text_editor 拆 Edit + Write (+ deprecated alias) │
│  T-2 read/edit/write 启用结构化 diff 字段             │
│  T-3 conflictKey 文件共享键                           │
└──────────────────────────────────────────────────────┘
                          ↓
┌─ Group P: 权限 overlay 增强 ─────────────────────────┐
│  P-1 contract 携带 input + cwd                        │
│  P-2 diff / cmd / write preview                       │
│  P-3 session-allow + 持久 always + /permissions       │
│  P-4 dangerousTools 同步拆分后名单                    │
└──────────────────────────────────────────────────────┘
                          ↓
┌─ Group S: Slash & Bash 快捷 ─────────────────────────┐
│  S-1 ! ext-source slash command + capability-hints    │
│  S-2 /help 含快捷键 (从 keymap 表派生, ctx.ui 注入)   │
│  S-3 ? 弹出 cheatsheet overlay (纯前端, 无 RPC)       │
└──────────────────────────────────────────────────────┘
                          ↓
┌─ Group V: 视觉提级 ──────────────────────────────────┐
│  V-1 Footer 三段 + K-3 hint 动态化   V-2 mode badge   │
│  V-3 InputBox 边框随状态  V-4 pending 紧凑模式        │
│  V-5 paste-fold 提示瘦身  V-6 picker 边框 + spinner   │
│  V-7 user/assistant 视觉区隔                          │
└──────────────────────────────────────────────────────┘
                          ↓
┌─ Group B+N: Bug 修复 ────────────────────────────────┐
│  B-1 divider key 冲突  B-2 widget 抢 Enter            │
│  B-3 双路径 ESC 冲突  N-1~N-10 Q10 深挖 bug          │
└──────────────────────────────────────────────────────┘
```

> PR 编号以 §9 表为单一来源;上图仅标注逻辑分组不标注 PR。

> **不含**: transcript reverse search、`$EDITOR` 多行编辑、单工具折叠、empty-state hero、token bar marker 精修、IME 适配、widget focus ring、session picker fuzzy search。下一轮。

---

## 1. Group A — 架构基座（所有 Group K/S/V/B/N 的前置）

### A-1 KeyDispatcher 升级

**Root cause**: 项目内 3 处全局 `useInput`（`InputBox.tsx:52` / `use-slash-input.ts:230` / `widget-subagent-task.tsx:56-58`）。Ink `useInput` 是 stdin 广播总线，不冒泡不可消费；多挂导致 Enter 键被所有 widget 同时消费、Ctrl+T 被当成 `t` 字符插入输入框、overlay "拦截一切" 语义破产。

**当前已有 `input/key-dispatcher.ts`**（96 LOC）：LIFO stack + `push`/`pop`/`dispatch`，`KeyLayer` 接口有 `id`/`handler`/`priority?` 但 `priority` 未在 push 时排序。`InkKey` 和 `inkKeyToKeyEvent` 已存在。

**升级改动**:

1. `push` 改为按 priority 降序插入（priority 默认 0）。同 priority LIFO。
2. `KeyLayer` 加 `when?: () => boolean` 动态门。
3. `dispatch` 检查 `when()` 后再调 handler。
4. 整个 TUI **仅 1 个** `useInput`，放在 App 顶层。

**新增文件** `keys/priority.ts`:
```ts
export const PRIORITY = {
  MODAL:        100,   // cheatsheet / 全屏弹窗
  PICKER:        80,   // slash-list / file-picker / session-picker
  GLOBAL_CHROME: 20,   // ctrl+t/d/o, esc-abort, ctrl+k, ctrl+c, ?
  INPUT_EDIT:    40,   // ctrl+a/e/w, tab 补全, 方向键
  FALLTHROUGH:    0,   // 输入框文本写入兜底
} as const;
```

**新增文件** `keys/use-key-layer.ts`:
```ts
export function useKeyLayer(
  layer: Omit<KeyLayer, 'id'> & { id?: string },
  deps?: unknown[],
): void {
  const id = useMemo(() => layer.id ?? crypto.randomUUID(), []);
  const handleRef = useRef(layer.handle);
  handleRef.current = layer.handle;
  useEffect(() => {
    keyDispatcher.push({ ...layer, id, handle: (ev) => handleRef.current(ev) });
    return () => keyDispatcher.pop(id);
  }, deps ?? []);
}
```

**App.tsx 唯一入口**:
```tsx
useInput((rawInput, rawKey) => {
  keyDispatcher.dispatch(normalizeKey(rawInput, rawKey));
});
```

**决策**:
- Layer 注销时机: effect cleanup
- 同 priority 多 layer: LIFO
- dispatcher 模块级 singleton，不通过 React Context

**LOC**: ~70（升级 dispatcher 30 + priority.ts 10 + useKeyLayer 20 + tests 10）

---

### A-2 Ink 输入规范化

**Root cause**: Ink 5 的 `useInput` handler 中 `input = keypress.ctrl ? keypress.name : keypress.sequence`。Ctrl+T → `input='t'` + `key.ctrl=true`。下游若未显式判 `key.ctrl`，会把 `t` 当文本写入输入框（N-3）。

**新增文件** `keys/normalize.ts`:
```ts
export function normalizeKey(input: string, key: InkKey): KeyEvent {
  const named =
    key.return ? 'enter' : key.escape ? 'escape' : key.tab ? 'tab' :
    key.backspace ? 'backspace' : key.delete ? 'delete' :
    key.upArrow ? 'up' : key.downArrow ? 'down' :
    key.leftArrow ? 'left' : key.rightArrow ? 'right' :
    key.pageUp ? 'pageup' : key.pageDown ? 'pagedown' : undefined;

  // macOS option+← 双兜底: key.meta=true 或 escape sequence \x1bb/\x1bf
  if (input === '\x1bb' || input === '\x1b[1;3D')
    return { key: 'left', ctrl: !!key.ctrl, meta: true, shift: !!key.shift, raw: input };
  if (input === '\x1bf' || input === '\x1b[1;3C')
    return { key: 'right', ctrl: !!key.ctrl, meta: true, shift: !!key.shift, raw: input };

  return {
    key: named ?? input,
    ctrl: !!key.ctrl, meta: !!key.meta, shift: !!key.shift,
    raw: input,
  };
}
```

**决策**:
- macOS option 键双兜底（key.meta + escape sequence）
- bracketed paste `[I`/`[O` 透传 raw

**LOC**: ~35（含 tests）

---

### A-3 分层 keymap 集中

**Root cause**: `chrome/keymap.ts`(86 LOC) 仅提供 hotkey 数组无显示元数据；`Footer.tsx:50-53` 硬编码 hint；`/help` 不知道快捷键。三处事实分离易漂移。

**改动**: 删除 `chrome/keymap.ts`，替换为三个静态常量表：

**`keys/global-keymap.ts`**（新建）:
```ts
export interface GlobalBinding {
  id: string;
  label: string;            // "Ctrl+T"
  description: string;      // "Toggle thinking display"
  key: string;
  ctrl?: boolean; meta?: boolean; shift?: boolean;
  scope: 'global' | 'modal-trigger';
  hintPriority?: number;
  showInFooter?: boolean;
  guard?: (ctx: GlobalKeyCtx) => boolean;
  action: string;           // 解耦: 'abort' | 'toggle-thinking' | ...
}

export interface GlobalKeyCtx {
  streaming: boolean;
  pendingCount: number;
  inputFocused: boolean;
  mode: string;
}
```

App.tsx 一次性注册 GLOBAL_CHROME layer，遍历 `GLOBAL_BINDINGS` 匹配 → dispatch action → callback。InputBox 内聚 `INPUT_BINDINGS`（编辑器键），picker 内聚 `PICKER_BINDINGS`。

Footer/help/cheatsheet 消费三表 union。**keyMeta registry 不做**——三个静态数组 + filter 足够。

**决策**:
- 全局键集中 global-keymap，组件局部键分散
- 单测断言 "no duplicate chord"（集中式才能写）
- Footer 宽度不足时按 hintPriority 降序裁剪

**LOC**: ~95（global-keymap 40 + 表定义更新 + N-9 GlobalKeyCtx ctx 收集逻辑 15 + 删除旧 keymap -86, 净 +9）

---

## 2. Group K — KeyMap 对齐

### K-1 词/行光标跳转

`use-input-editor.ts` 新增 5 个纯函数：`moveCursorWordLeft/Right`（词边界 `/[\p{L}\p{N}_]/u`，readline 风格）、`moveCursorLineStart/End`、`deleteWordBeforeCursor`。通过 INPUT_EDIT layer 注册。

**LOC**: ~120

### K-2 双击 Ctrl+C 退出

删 `input-key-handler.ts:66` ctrl+c 分支。App.tsx 在 GLOBAL_BINDINGS 注册 `action:'exit-or-abort'`：第一次 abort（或清输入），500ms 内第二次 `inkInstance.unmount()` + `process.exit(0)`。store 增 `transient.hint`，InputBox 上方渲染 "Press Ctrl+C again to exit"，setTimeout 自动清。

`run-tui.tsx` 通过 ref 暴露 `inkInstance` 给 App 层。

**决策**: 先 `unmount()` 再 `process.exit(0)`，二者同步；`within` 判断优先于 `streaming`。

**LOC**: ~100

### K-3 → V-1.b footer hint 由 keymap 表驱动

Footer 从 GLOBAL_BINDINGS 动态拼接 hint，实现在 PR-8 的 V-1 中完成。本子项是 V-1 的子任务，不独立算 LOC。

---

## 3. Group T — 工具拆分与 diff 激活

### T-1 text_editor 拆 Edit + Write

**删除**: `tool-schemas/text-editor.ts`(16 LOC) + `tools/text-editor.ts`(105 LOC)。

**新建**:
- `tools/edit.ts` (~45 LOC): `name:'edit'`, schema `{path, old_string, new_string}`, `conflictKey: file:<absPath>`
- `tools/write.ts` (~35 LOC): `name:'write'`, schema `{path, content, overwrite?}`, `conflictKey: file:<absPath>`
- `tools/_diff.ts` (~30 LOC): `buildDiffHunks(a,b): DiffData` — 用 `diff` 库 `structuredPatch`（需 `bun add diff @types/diff`）

**修改**: `tools/index.ts` 删 text_editor 注册，改注册 edit + write。

**Legacy 兼容**: `tools/index.ts` 注册 `text_editor` 为 deprecated alias，内部 route 到 edit/write（按 command 字段），加 deprecation warning log。旧 history replay 不会报 "tool not found"。

**LOC**: ~165（新增 +20 alias 注册逻辑）

### T-2 启用结构化 diff 字段

`tool-format.ts:9-17` `DiffData` 从死代码激活。T-1 的 edit/write 产出 `diff: DiffData`。删 `tool-format.ts:182-185` read diff 死分支。

**LOC**: ~35

### T-3 conflictKey 文件共享键

read/edit/write 全部加 `conflictKey: (args) => 'file:${path.resolve(args.path)}'`。

**LOC**: ~15

---

## 4. Group P — 权限 overlay 增强

### P-1 contract 携带 input + cwd

`permission-events.ts` `PermissionRequiredV1` 扩字段（additive）: `input: unknown`, `cwd: string`, `inputTruncated?: boolean`, `description?: string`。超 64KB 截断并标记。前端透传，Lark 同步透传不渲染。

**LOC**: ~50

### P-2 diff / cmd / write preview

新建 `overlays/impls/overlay-permission/preview.tsx`: 按 toolName 路由到 DiffPreview（±3 行上下文，超 30 行折叠，行长 >200 截断）、WritePreview（path + 前 20 行）、CommandPreview（`$ cmd`，>120 字符截断）、JsonPreview（>30 行折叠）。后端附带 `diff` 字段优先，无则前端 fallback `diffLines`。

`overlay-permission.tsx` 在 reason 和 y/a/n 之间插入 `<ToolInputPreview />`。

**决策**: 前端 derive + 后端预 build 两端兼容。Ink Text 直接着色，不接 prism。

**LOC**: ~200

### P-3 session-allow + 持久 always + /permissions

**存储**: `ctx.paths.permissions` = `<agentDir>/permissions.json`，格式 `{ version:1, alwaysAllow: string[] }`。新建 `PermissionStore` 类，注入 `ctx.paths`。

**Overlay 4 选项**: `y`（allow once）/ `a`（this session）/ `Y`（always, 持久化）/ `N`（deny）。`Y` 写入 permissions.json，重启后生效。

**`/permissions` slash command**: ~80 LOC，列出 always-allowed 工具 + 方向键选中 + Delete 移除。P-3 PR 必须带，不可延后。

**AgentPaths 扩展**: 新增 `permissions: string` 字段，`createAgentPaths` 计算为 `path.join(agentDir, 'permissions.json')`。

**启动 banner**: 若文件存在且非空，显示 "N tools have always-allow permission. Run /permissions to review."

**LOC**: ~200

### P-4 dangerousTools 同步

`permission/index.ts:73` 默认值 `['bash', 'edit', 'write', 'task']`，删 bash_run/exec。

**LOC**: ~3

---

## 5. Group S — Slash & Bash 快捷

### S-1 `!` 前缀直跑 bash

**Ext-source slash command**（非 PromptSubmission discriminated union）:

1. **输入层重写**（TUI 私有 `input-key-handler.ts`）: `! cmd` → `/! cmd`，history 保留原始 `! cmd`
2. **`tools` extension 注册 slash**: 新增 `slash-bash.ts`，注册 `/!` slash command（`source:'ext'`, `visible:false`），内部调 `dispatchTool` 复用 bash 工具 pipeline（权限/sandbox/timeout），结果走 `render-widget` widget
3. **`use-input-history.ts:120`**: skip pattern 扩为 `^[/@!]`
4. **`PromptSubmission` 不改**——bash shortcut 走 slash 管道，不污染 contract
5. **InputBox 空态 hint**: 显示 `! for bash mode · / for commands · @ for files · ↑ for history`

**`frontend-capability-hints` extension**（新建）:
```ts
defineExtension({
  name: 'frontend-capability-hints',
  enforce: 'post',
  apply: () => ({
    hooks: {
      transformPrompt: {
        enforce: 'normal',
        fn: (prompt, ctx) => {
          if (ctx.frontend !== 'tui') return prompt;
          const hints = INPUT_PREFIXES.map(p => `  ${p.prefix} — ${p.label}`).join('\n');
          return injectIntoSystem(prompt, `<!-- user-shortcuts\n${hints}\n-->`);
        },
      },
    },
  }),
})
```

`INPUT_PREFIXES` 常量在 `frontend.tui/input/input-prefixes.ts`:
```ts
export const INPUT_PREFIXES = [
  { prefix:'!', label:'bash shortcut', llmHint:'- `! <command>` — Directly execute a bash command' },
  { prefix:'/', label:'slash commands', llmHint:'- `/<command>` — Invoke a slash command' },
  { prefix:'@', label:'file attachment', llmHint:'- `@<file>` — Attach a file' },
] as const;
```

**LOC**: ~215

### S-2 `/help` 含快捷键

`slash-types.ts` `SlashContext.ui` 加 `getCheatsheet?(): { scope:string; bindings:Array<{label,description}> }[]`。App.tsx 注入实现，读 GLOBAL_BINDINGS + INPUT_BINDINGS + PICKER_BINDINGS 三表 union 分组。`slash-help.ts` 末尾追加 "Keyboard shortcuts" 段。

**决策**: 跨平台全用 `Ctrl+`/`Alt+`（不用 macOS 修饰符符号）。SystemNoticeView 纯文本渲染（已确认）。

**LOC**: ~80

### S-3 `?` 弹出 cheatsheet overlay

App 在 GLOBAL_BINDINGS 注册 `action:'open-cheatsheet'`（`guard: !inputFocused`）。新建 `overlays/impls/overlay-cheatsheet.tsx`：消费三表 union 分组渲染，按 scope 分组（Global/Input/Picker），Esc/`?` 关闭。自身 push MODAL layer 屏蔽下层。

**决策**: 纯前端 overlay，无 RPC。输入框 focus 时 `?` 正常插入字符。

**LOC**: ~80

---

## 6. Group V — 视觉提级

### V-1 Footer 三段布局

重构 `Footer.tsx`：hint 弹性 + metrics 固定 36ch + status 固定 14ch。hint 从 GLOBAL_BINDINGS 动态拼接（按 hintPriority 排序，宽度不足时裁尾部）。`out:` 字段 `completionTokens===0` 时隐藏。status badge 实色块 + 文字（不 dim）。段间 `|` 分隔。

**LOC**: ~60

### V-2 Header mode badge 反白

`Header.tsx:37` 改为 `<Text inverse color="magenta"> plan </Text>`（仅 mode !== 'normal'）。MODE_BADGE 表: `plan→{bg:'magenta',fg:'white'}`, fallback `bg:'gray'`。

**LOC**: ~25

### V-3 InputBox 边框随状态

`borderColor`: streaming→'gray', pending>0→'yellow', default→'cyan'。streaming 时 placeholder 覆盖为 "(replying… Esc to interrupt, Enter to queue)"。

**LOC**: ~15

### V-4 Pending 紧凑模式

1 条 pending: 单行 `[queued] <truncated text> · Ctrl+K to clear`。>1 条: 保留多行 box。配合 N-8 改造，`p.text` 取代字符串。

**LOC**: ~35

### V-5 paste-fold 提示瘦身

`📋` 改 `[paste]`，文案精简为 `[paste] folded (N lines) · ? for help`（≤40 字符）。详细操作迁移到 cheatsheet。

**LOC**: ~20

### V-6 picker 边框 + spinner

`slash-command-list.tsx:28` borderStyle `"single"`→`"round"`，补 `borderColor="gray"`。`file-picker-popover.tsx` 加 `borderStyle="round" borderColor="gray" paddingX={1}`。`InputBox.tsx:81` searching 接 `useSpinner()` hook。

从 `StreamingIndicator.tsx` 抽取 `components/use-spinner.ts`(~15 LOC)，StreamingIndicator 改用此 hook(-3 LOC)。零新依赖。

**LOC**: ~40

### V-7 user/assistant 视觉区隔

方案 B：单 `<Text>` 拼接 `content.split('\n').map(l => `│ ${l}`).join('\n')`。>200 行降级顶格 dim + 尾行 `(N lines, prefix omitted)`。assistant 保持顶格。已知限制: terminal wrap 后物理换行不带 `│`；select+copy 带 `│` 字符。

**LOC**: ~60

---

## 7. Group B — 原 spec 已发现 bug

### B-1 divider key 冲突

`state/types.ts` divider 加 `id: string`，`store.ts:appendDivider` 生成 nanoid，`App.tsx:finalItemKey` 用 `divider-${item.id}`。`message-converter.ts` 重建路径同步加 id。

**LOC**: ~20

### B-2 widget-subagent-task 全局 useInput

由 A-1 根治：删 widget 内 `useInput`，改 `useKeyLayer`。当前版暂以 `when:()=>false` 禁用 Enter toggle（widget focus ring 下一轮）。sub-agent task widget 降为单行 summary（不再展开内层 tool 列表），详情通过未来 `/subagent <id>` 命令查看。

**LOC**: ~20

### B-3 双路径 ESC 冲突

由 A-1/A-3 根治：`chrome/keymap.ts` Esc hotkey 删除（随文件删除）。streaming 中 ESC abort 统一由 streaming-mode layer 负责。

**LOC**: ~10

---

## 8. Group N — Q10 深挖新增 bug

### N-1 InputBox.tsx:52 全局 useInput 污染

删 `useInput` 块，改 INPUT_EDIT + FALLTHROUGH layer。~15 LOC。

### N-2 use-slash-input.ts:230 第二个全局 useInput

删 `useInput`，改 `useKeyLayer({priority:PRIORITY.PICKER, when:()=>pickerOpen})`。~12 LOC。

### N-3 input-key-handler.ts:182 缺 ctrl/meta 过滤

并入 N-1。FALLTHROUGH layer: `if(ev.ctrl||ev.meta) return false`。

### N-4 App.tsx 缺 onToggleThinking/Debug

由 GLOBAL_BINDINGS action 字符串自动绑定 store action，~5 LOC。

### N-5 file-picker marker 不一致

`file-picker-popover.tsx:24` `>` → `❯ `，与 slash-list 对齐。±0 LOC。

### N-6 tokenLimit 前后端双源

`App.tsx:12` `DEFAULT_TOKEN_LIMIT=200_000` → import `BUDGET_DEFAULT_TOKEN_LIMIT` from compact constants（180k），统一源。~1 LOC。

### N-7 paste 提示文案超 40 字

并入 V-5。

### N-8 pendingInputs 用 index 当 key

`state/types.ts:42` → `pendingInputs: Array<{id:string; text:string}>`。`store.ts` enqueue 生成 id，所有消费点用 `p.id` 当 key。~12 LOC。

### N-9 KeymapContext 缺 mode 字段

由 A-3 `GlobalKeyCtx` 包含 mode 字段替代。旧 KeymapContext 随 chrome/keymap.ts 删除废弃。

### N-10 InputBox.tsx:81 searching 文本静态

并入 V-6（useSpinner hook）。

---

## 9. PR 切分

| PR | 内容 | LOC | 依赖 |
|---|---|---|---|
| **PR-1** | A-1 + A-2 + A-3 (架构基座: 升级 KeyDispatcher + normalize + 分层 keymap + App 顶层接管 + N-9 GlobalKeyCtx ctx收集) | ~200 | — |
| **PR-2** | N-1 + N-2 + N-3 + B-2 + B-3 (3 处全局 useInput 收口 + ESC 冲突修复) | ~85 | PR-1 |
| **PR-3** | K-1 + K-2 + N-4 (词光标 + 双击 Ctrl+C + 哑键修复) | ~235 | PR-1, PR-2 |
| **PR-4** | T-1 + T-2 + T-3 (工具拆分 + diff 激活 + conflictKey + deprecated alias) | ~215 | — |
| **PR-5** | P-1 + P-2 + P-4 (contract 扩 + preview + 名单同步) | ~253 | PR-4 |
| **PR-6** | P-3 (持久 always + /permissions command) | ~200 | PR-5 |
| **PR-7a** | S-1 + capability-hints extension (`!` ext-source slash + INPUT_PREFIXES + transformPrompt hook) | ~215 | PR-1 |
| **PR-7b** | S-2 + S-3 + B-1 + N-5 + N-6 + N-8 (/help cheatsheet + `?` overlay + divider id + picker marker + tokenLimit + pendingInputs key) | ~200 | PR-1 |
| **PR-8** | V-1 + V-2 + V-3 + V-4 (footer 三段 + K-3 hint 动态化 + header mode badge + input box 边框 + pending 紧凑) + N-7 | ~135 | PR-1 |
| **PR-9** | V-5 + V-6 + V-7 (paste 瘦身 + picker 边框/spinner + user `│` 前缀) + N-10 | ~120 | PR-1 |

**总计 ~1858 LOC**（含 -150 LOC 删除，净 ~1708 LOC）。

每 PR 独立可 ship、可回滚。PR-1 是所有键路由相关 PR 的根依赖。PR-4 是 PR-5 的根依赖（diff 数据契约）。PR-7b 可独立于 PR-7a 上（无依赖）。

---

## 10. 全局风险点

### R-1 KeyDispatcher 单入口事件丢失

所有 useInput 经 normalize 包装。若 normalize 漏了某个 key 名，会被 FALLTHROUGH 错误吞掉。
- **缓解**: 测试矩阵覆盖:
  - 所有 `InkKey` 布尔字段单独触发（return/escape/tab/backspace/delete/upArrow/downArrow/leftArrow/rightArrow/pageUp/pageDown）
  - ctrl/meta/shift 修饰键 × 26 字母 + 10 数字组合冒烟
  - macOS option+arrow 双兜底序列（`\x1bb` / `\x1bf` / `\x1b[1;3D` / `\x1b[1;3C`）
  - bracketed paste `[I` / `[O` 透传不被吞
  - 后续加 dispatcher debug overlay 作为运行时观测手段

### R-2 process.exit 与 Ink unmount

K-2 通过 ref 暴露 `inkInstance`。`unmount()` 同步完成再 `process.exit(0)`。已闭环。

### R-3 contract additive 不破坏 Lark

P-1 additive 字段，Lark 透传不渲染。需更新 contract snapshot。

### R-4 cheatsheet 与 footer hint 单源

三表 union，改一处全改。Footer/help/cheatsheet 消费同一数据。

### R-5 V-7 多行渲染

>200 行退化顶格，实现注释说明。

### R-6 工具拆分 history 重放

T-1 注册 `text_editor` deprecated alias（内部 route 到 edit/write + deprecation warning log），旧 history replay 不会报 "tool not found"。旧 LLM 选择 `text_editor` 工具的上下文仍可正常执行。

### R-7 P-3 持久 always 安全

启动 banner 提示 "N tools have always-allow permission. Run /permissions to review."

### R-8 已确认非范围

transcript reverse search、$EDITOR 多行编辑、单工具折叠、empty-state hero、ContextBar 阈值标记、IME 适配、session picker fuzzy search、KeyDispatcher debug overlay、widget focus ring。

---

## 11. 验收标准

通用: lint + type-check 通过、不引入新 console warning / Ink rerender 循环。

| PR | 关键验收 |
|---|---|
| PR-1 | dispatcher push/pop/priority/when 测试；normalize 按测试矩阵覆盖（布尔字段/修饰键×字母数字/macOS序列/粘贴透传）；App.tsx 仅剩 1 处 useInput |
| PR-2 | 提交 prompt 时 subagent widget 不一起 toggle；Ctrl+T/D 不插入字符；ESC 单路径 abort |
| PR-3 | option+← 按词跳；Ctrl+A/E/W 行编辑；双击 Ctrl+C 500ms 内退出且 terminal 恢复正常 |
| PR-4 | edit/write 产出 diff 字段；text_editor deprecated alias 路由正确、旧 history replay 不报错；并发同文件 read+edit 互斥 |
| PR-5 | Edit 触发 overlay 显示 diff；Write 显示前 20 行；Bash 显示命令；Read 不触发 |
| PR-6 | `Y` 写入 permissions.json；重启后不弹 overlay；`/permissions` 列出/移除；启动 banner |
| PR-7a | `!ls` 立即执行不入 LLM 上下文；LLM 系统提示包含 `<!-- user-shortcuts -->` 段；InputBox 空态提示前缀 |
| PR-7b | `/help` 含快捷键分组；`?` 弹 cheatsheet overlay Esc 关闭；`/clear`×3 divider 不冲突；tokenLimit 双源统一 |
| PR-8 | footer 3 段不溢出 80ch；mode badge 反白；streaming 边框灰 + placeholder 正确；1 条 pending 单行 `[queued]` |
| PR-9 | paste 提示 ≤40 字；picker 圆角灰边；searching 带 spinner；user content `│` 前缀 (≤200 行降级) |

端到端冒烟（手动）:
- streaming 中 ctrl+c×2 → unmount 不卡
- 打开 cheatsheet → `?` → 关闭
- 连续 `/clear`×3 → divider id 唯一

---

## Appendix A: Grilling 决策溯源

| Q | 主题 | 关键决议 |
|---|---|---|
| Q1 | R-1/B-2 键冲突 | 方案 D: widget 永远折叠改为单行 summary，Enter toggle 禁用 |
| Q2 | K-2 退出清理 | `inkInstance.unmount()` + `process.exit(0)`，同步调用足够 |
| Q3 | P-3 持久化路径 | `ctx.paths.permissions` = `<agentDir>/permissions.json`，不手拼路径 |
| Q4 | 跨平台键修饰符 | 单源收敛到 input/ 目录，`/help` 走 ctx.ui 注入不破 A20 |
| Q5 | S-1 `!` bash | ext-source slash command + capability-hints extension + INPUT_PREFIXES |
| Q6 | P-2 diff 渲染 | Edit 参数 path/old_string/new_string，Write 参数 path/content |
| Q7 | V-7 性能边界 | 方案 B: 单 Text 拼接，>200 行阈值降级 |
| Q8 | V-1/V-2 视觉协调 | Footer 单行 + mode badge 反白 + metrics 单源 + /help 不碰 |
| Q9 | V-6 spinner | 方案 C: 从 StreamingIndicator 抽取 useSpinner hook，零新依赖 |
| Q10 | Spec 修订范围 | 新增 Group A(架构基座) + T(工具拆分) + N(10 个新 bug) |
| Q11 | v2 与决议冲突 | 3 处全部是起草遗漏，逐条回退到 Q3/Q5/Q7 决议 |
| Q12 | keymap 删除 vs 保留 | 分层集中: global-keymap + input-keymap + picker-keymap |
| Q13 | ext-slash 注册基建 | 已存在（collectSlashCommands），S-1 无前置依赖 |
| Q14 | 最终范围分歧 | `/permissions` 必须带；capability-hints transformPrompt 必须带 |
