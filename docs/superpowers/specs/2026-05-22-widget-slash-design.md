# Spec: TUI Widget × Slash 前端贡献机制

## TL;DR

定义 TUI 前端的 Widget（视图渲染）+ Slash（用户输入入口）两套扩展机制。ext 通过 type-only `widget-payloads.ts` + `declare module` 贡献 payload 类型，TUI 侧通过 `WidgetDescriptor` 实装组件。ext 不依赖 React/ink。Slash 完全归 TUI，通过 RPC 代理 ext 能力。

---

## 0. 已锁定决策（grill-me 产出）

| # | 议题 | 结论 |
|---|---|---|
| D1 | `application/commands/` 去留 | W4 整个删除，7 builtin 迁入 `slash/builtin/` |
| D2 | SlashRegistry reactive？ | 不需要——启动时一次性构建 |
| D3 | WidgetPayloadMap 位置 | contracts 空接口 + ext `declare module` 增强 |
| D4 | verbatimModuleSyntax | 兼容，side-effect import 原样保留 |
| D5 | W1 改名范围 | 4 个机械改名 + FilePicker PR 时判定；hook 一概不动 |
| D6 | PR 拆分 | 6 PR：W1+W2 → W4 → W3 → W5 → W6(可选) → W7.x |
| D7 | ext widget 接入 | 4 ext (trace/memory/skills/evolution)，mcp 仅 CLI |
| D8 | declaration merging | A19.6(声明侧) + A19.7(注册侧) guard 联防 |
| D9 | ext 私有 hook | C3 类归 overlay 子目录，W5 阶段处理 |

---

## 1. 目标拓扑

```
src/application/contracts/
├── widget-events.ts                    ← InlineBlockV1 + emitInlineBlock helper
└── widget-payload-map.ts               ← 空接口 WidgetPayloadMap（ext 通过 declare module 增强）

src/extensions/<ext>/
├── widget-payloads.ts                  ← type-only，export *Payload + declare module
└── index.ts                            ← daemon 侧 emitInlineBlock

src/extensions/frontend.tui/
├── widgets/                            ← Widget 域（类目 A：Inline Block）
│   ├── widget-types.ts                 ← WidgetDescriptor<P>
│   ├── widget-registry.ts              ← WIDGETS: WidgetMap + side-effect import 区
│   └── impls/
│       ├── widget-memory-list.tsx
│       ├── widget-todo-list.tsx
│       └── widget-trace-show.tsx
├── panels/                             ← Widget 域（类目 B：常驻面板）
│   ├── panel-types.ts
│   ├── panel-registry.ts
│   └── impls/
├── overlays/                           ← Widget 域（类目 C：模态）
│   ├── overlay-types.ts                ← OverlayDescriptor<Req, Res>
│   ├── overlay-registry.ts             ← useOverlayStack
│   └── impls/
│       ├── overlay-permission/
│       │   ├── overlay-permission.tsx
│       │   └── use-permission-manager.ts
│       └── overlay-ask-user-question/
├── slash/                              ← Slash 域
│   ├── slash-types.ts                  ← SlashCommand, SlashContext, SlashResolution
│   ├── slash-registry.ts               ← SlashRegistry class
│   ├── slash-input.ts                  ← 原 use-command-input.ts
│   ├── slash-args.ts
│   ├── slash-groups.ts
│   ├── builtin/                        ← TUI 内置 slash
│   │   ├── slash-clear.ts
│   │   ├── slash-help.ts
│   │   └── ...
│   ├── ext/                            ← ext 在 TUI 的入口
│   │   ├── slash-memory.ts
│   │   └── slash-trace.ts
│   └── loaders/                        ← skill/agent 动态加载
│       ├── load-skill-slashes.ts
│       └── load-agent-slashes.ts
└── hooks/                              ← C1(UI 原语) + C2(TUI 框架) hook
    ├── use-input-editor.ts
    ├── use-input-history.ts
    ├── use-bracketed-paste.ts
    ├── use-agent-subscription.ts
    └── use-session-picker.ts
```

---

## 2. Widget 类目划分

| 类目 | 触发方式 | 生命周期 | Registry |
|---|---|---|---|
| **A. Inline Block** | daemon 推送 `tui.inline-block` 事件 | 被动渲染，随 transcript 流 | `WIDGETS: WidgetMap` |
| **B. Panel** | TUI mount 时永久挂载 | 主动订阅，自拉数据 | `PANELS: PanelDescriptor[]` |
| **C. Overlay** | daemon 主动调起 `request.<name>` | LIFO 模态栈，阻塞输入 | `overlayStack` |

---

## 3. 类目 A — Inline Block

### 3.1 数据流

```
daemon: emitInlineBlock(bus, { widget: 'memory.list', payload })
  → transport → dataplane
    → from-dataplane.ts → FinalItem { kind: 'widget', ... }
      → FinalItemView → lookupWidget → <MemoryListView payload={...} />
```

### 3.2 契约层（空接口 + declaration merging）

```ts
// src/application/contracts/widget-payload-map.ts
/** WidgetPayloadMap — SSOT for widget name ↔ payload shape. Ext增强 via declare module. */
export interface WidgetPayloadMap {
  // 故意为空 — ext 通过 declare module 增强
}

export type WidgetName = keyof WidgetPayloadMap
export type WidgetPayloadFor<W extends WidgetName> = WidgetPayloadMap[W]
```

```ts
// src/application/contracts/widget-events.ts
export function emitInlineBlock<W extends WidgetName>(
  bus: ContractBus,
  args: { sessionId: string; widget: W; payload: WidgetPayloadFor<W>; blockId?: string; mode?: 'append' | 'replace' },
): void { /* ... */ }
```

### 3.3 Ext 侧（type-only payload + declare module）

```ts
// src/extensions/memory/widget-payloads.ts（type-only，不得有运行代码——A19.3）
export interface MemoryListPayload {
  readonly items: ReadonlyArray<{ id: string; scope: string; text: string; score: number }>
  readonly total: number
}

declare module '../../application/contracts/widget-payload-map' {
  interface WidgetPayloadMap { 'memory.list': MemoryListPayload }
}
```

### 3.4 TUI 侧（WidgetDescriptor + registry + side-effect import）

```ts
// src/extensions/frontend.tui/widgets/widget-types.ts
export interface WidgetDescriptor<P = unknown> {
  readonly name: string
  readonly Component: ComponentType<{ payload: P }>
}
```

```ts
// widget-registry.ts
// Side-effect imports — 触发 declare module 合并（A19.7 强制此列表与 payload 文件同步）
import '../../memory/widget-payloads'
// ... per ext

type WidgetMap = { [W in WidgetName]: WidgetDescriptor<WidgetPayloadFor<W>> }

export const WIDGETS: WidgetMap = { /* ... */ }

export function lookupWidget(name: string): WidgetDescriptor | null {
  return (WIDGETS as Record<string, WidgetDescriptor>)[name] ?? null
}
```

### 3.5 投影到 transcript

`from-dataplane.ts` 增加 `tui.inline-block` case → `FinalItem { kind: 'widget' }`。`FinalItemView` 查 `lookupWidget` 渲染。

---

## 4. Slash 系统

### 4.1 SlashCommand 类型

```ts
// slash/slash-types.ts
export type SlashSource = 'builtin' | 'ext' | 'skill' | 'agent'

export interface SlashCommand {
  readonly name: string
  readonly description: string
  readonly source: SlashSource
  readonly aliases?: ReadonlyArray<string>
  readonly group?: string
  readonly resolve: (input: string, ctx: SlashContext) => Promise<SlashResolution>
}
```

### 4.2 SlashRegistry

启动时一次性构建，无 runtime 变更。`register()` / `get()` / `list()` / `resolve()`。

### 4.3 来源四分类

| 来源 | 注册路径 | 示例 |
|---|---|---|
| A. builtin | 静态 import | `/clear` `/help` `/cost` |
| B. ext | 静态 import，handler 调 RPC | `/memory` `/trace` |
| C. skill | RPC 拉 skill 列表，动态注册 | `/refactor-component` |
| D. agent | RPC 拉 agent 列表，动态注册 | `/backend-expert` |

### 4.4 SlashResolution 与 Widget 对接

```ts
export type SlashResolution =
  | { kind: 'render-widget'; widget: WidgetName; payload: WidgetPayloadFor<WidgetName> }
  // ...
```

## 5. 命名规范

| 类目 | 类型前缀 | 文件命名 | 目录 |
|---|---|---|---|
| Inline Widget | `Widget*` | `widget-*.tsx` | `widgets/` |
| Panel | `Panel*` | `panel-*.tsx` | `panels/` |
| Overlay | `Overlay*` | `overlay-*.tsx` | `overlays/` |
| Slash | `Slash*` | `slash-*.ts` | `slash/` |

**禁词**:裸 `Widget`/`Panel`/`Overlay`/`Command` 不带类型前缀。

## 6. Arch Guards

| ID | 规则 | Phase |
|---|---|---|
| A19.1 | WidgetPayloadMap 声明的 widget 必须在 WIDGETS 实装 | W2 |
| A19.2 | ext 不得 import ink/react（仅 frontend.tui 例外） | W2 |
| A19.3 | widget-payloads.ts 必须 type-only | W2 |
| A19.4 | Panel registry 完整性 | W6 |
| A19.5 | Overlay registry 完整性 | W5 |
| A19.6 | widget-payloads.ts 必须含 declare module 块 | W2 |
| A19.7 | widget-registry.ts 必须 side-effect import 所有 widget-payloads | W2 |
| A19.8 | hooks/ 禁止含 ext 专属协议名 | W5 |
| A18.5 | SlashCommand 类型不得跨出 frontend.tui | W4 |

## 7. Phase 拆分

| Phase | 内容 | 体量 |
|---|---|---|
| **W1+W2** (PR1) | 命名清理 4 组件 + Widget 契约基础设施 | 中 |
| **W4** (PR2) | Slash 系统接替 application/commands + 7 builtin 迁移 | 大·纯机械 |
| **W3** (PR3) | TodoPanel→widget.todo.list 端到端验证 | 小·关键 |
| **W5** (PR4) | Overlay registry + ext hook 归位 | 中-大 |
| **W6** (PR5) | Panel registry（可选/低优） | 中 |
| **W7.x** (PR6.x) | 各 ext widget 接入（trace/memory/skills/evolution） | 各小 |

**依赖**: PR1 → {PR2, PR3, PR4, PR5}；PR2+PR3 可并行；W7.x 依赖 PR2。
