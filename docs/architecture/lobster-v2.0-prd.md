# Lobster v2.0 PRD + ERD 终稿

> 版本:v2.0-final · 日期:2026-05-17 · 作者:隐私安全 / my-agent-dev
> 范围:my-agent-dev 重构,以 Kernel + Extensions(Vite-style)+ DDD 为主线
> 前置假设:Phase 1+2 防腐基线已全部完成

---

## 1. 业务故事(Business Stories)

Lobster 的核心使命是让 Agent 成为一个**有身份、有记忆、可演化、跨入口共享**的常驻助手,而非一次性会话工具。下述五条用户旅程构成 v2.0 必须支撑的最小业务面。

### UJ-1 跨入口接管(Cross-entry handoff)
**角色**:开发者 A
**场景**:在 TUI 启动一个 turn 跑长任务,关掉终端去开会;会中用飞书 Bot `@Agent` 询问进展,收到的是同一个 Session 的实时输出与 trace。会后回到工位,`mira attach` 重新贴回原 session,看到中间所有事件回放。
**关键能力**:Daemon 常驻 · Session 与 Frontend 解耦 · DataPlane 事件流可游标重放 · ControlPlane attach/detach。

### UJ-2 多前端联动(Multi-frontend co-view)
**角色**:开发者 A + 同事 B
**场景**:A 在 TUI 跑 turn,B 通过飞书 Bot 同时观察输出并代为审批一次工具调用(permission)。审批结果回写给 Kernel,turn 在 A 的 TUI 上继续推进。
**关键能力**:N 个 Frontend 共享一个 Session · 权限请求按 `lastInputFrontendId` 路由 · 审批事件广播。

### UJ-3 Profile 切换(Profile switching)
**角色**:同一开发者,工作 / 个人两套画像
**场景**:`mira --profile work` 与 `mira --profile personal` 各自常驻独立 Daemon,workspace、memory、identity 三元隔离;切换 profile 不会污染对方的记忆与身份。
**关键能力**:Profile 级三元隔离 · 一 Profile 一 Daemon 进程 · 配置三层覆盖。

### UJ-4 自演化闭环(Evolution self-iteration)
**角色**:开发者长期使用
**场景**:用户多次拒绝某种回答风格,Trace 持续落盘 → Memory 沉淀偏好 → Evolution 离线扫描 trace 提出 identity diff 提案 → 用户在 Review 面板确认后写回 Identity → 后续 turn 的 system prompt 自动反映新偏好。
**关键能力**:Trace 单职责广播 · Memory/Evolution 自订阅 · Identity 版本化与回滚 · Review 工作流。

### UJ-5 冷启动可用(Cold start usability)
**角色**:新用户
**场景**:`mira init` 一键生成默认 Profile,首次 turn ≤ 3 秒内出现首个 token,无需手动配 MCP / Skills 即可正常对话;按需逐步添加扩展。
**关键能力**:Kernel 启动闭环 · 默认 Provider/Memory/Skills 即装即用 · MVP Stub 退化路径。

---

## 2. 业务目标(Business Goals)

### 2.1 业务北极星
| 指标 | 现状(Phase 2 已修) | v2.0 目标 |
|---|---|---|
| 跨入口接管成功率 | 单入口,不支持 | ≥ 99% |
| 首 token 延迟(冷启动 turn) | ≈ 8s | ≤ 3s |
| Daemon 7×24 稳定性 | 单进程 ≤ 4h 崩溃 | MTBF ≥ 7d |
| Trace → Memory/Evolution 解耦 | 硬编码调用链 | 0 直接 import |
| Profile 切换数据泄露 | 偶发 | 0 起 |
| 新增子系统平均接入成本 | 动 5+ 文件 | 单扩展目录 + 1 处 `kernel.use(...)` |

### 2.2 工程质量目标(Engineering Goals)
- **GG-1 单职责**:Kernel 仅负责生命周期 / 注册 / 调度,不含业务。
- **GG-2 显式依赖**:扩展间禁止跨目录直接 import,只能通过 hook / capability / bus。
- **GG-3 可演化**:任一扩展可被替换实现(InMemory / 真实)而不动 Kernel。
- **GG-4 可独立交付**:M-1 ~ M-10 任一里程碑可独立合入主干并发布灰度。
- **GG-5 协议稳定**:ControlPlane / DataPlane 用 JSON Schema 锁定,跨版本兼容。
- **GG-6 可观测**:每个扩展启停、hook 链耗时、bus 订阅数都可被 Trace 捕获。

### 2.3 范围与非目标
**In-scope**:Kernel 框架、16 个扩展、ControlPlane(JSON-RPC over UnixSocket)、DataPlane(NDJSON)、TUI / Lark 两个 Frontend。
**Out-of-scope(本期不做)**:多机分布式、跨 Profile 共享记忆、Web 前端、第三方 Plugin Marketplace。

---

## 3. 架构设计(Architecture Design)

### 3.1 顶层架构图

```
┌────────────────────────────────────────────────────┐
│                  Interface 层                       │
│  CLI("mira")  Daemon(main.ts)                      │
└──────────────────┬─────────────────────────────────┘
                   ▼
┌────────────────────────────────────────────────────┐
│                  Kernel 框架(轻)                     │
│  ExtensionRegistry  HookContainer  EventBus         │
│  KernelContext      TopoSort(Kahn+优先级)           │
└──────────────────┬─────────────────────────────────┘
                   ▼
┌────────────────────────────────────────────────────┐
│              Extensions 层(16 个,Vite-style)        │
│  trace memory skills tools permission               │
│  provider mcp identity session evolution            │
│  controlplane dataplane transport.unix/inmem        │
│  frontend.tui frontend.lark                         │
└──────────────────┬─────────────────────────────────┘
                   ▼
┌────────────────────────────────────────────────────┐
│              Application 层(用例 + Ports)            │
│  Usecases          Ports(接口)                      │
└──────────────────┬─────────────────────────────────┘
                   ▼
┌────────────────────────────────────────────────────┐
│              Domain 层(纯模型)                       │
│  Session/Turn/Trace/Memory/Identity/Skill/Profile   │
└──────────────────┬─────────────────────────────────┘
                   ▼
┌────────────────────────────────────────────────────┐
│           Infrastructure 层(适配器)                  │
│  Adapters(SQLite/FS/HTTP/Lark SDK ...)             │
└────────────────────────────────────────────────────┘
```

### 3.2 分层职责(DDD 四层)

| 层 | 路径 | 职责 | 禁止 |
|---|---|---|---|
| Domain | `src/domain/` | 纯实体、值对象、聚合不变量 | 任何 IO / 框架引用 |
| Application | `src/application/` | Usecase 编排 + Port 接口 | 直接 new 适配器 |
| Infrastructure | `src/infrastructure/` | Port 的真实实现(DB / HTTP / SDK) | 反向依赖 Domain 之外 |
| Interface | `src/interface/` | CLI / Daemon entrypoint | 含业务逻辑 |
| Kernel | `src/kernel/` | 生命周期 / 注册 / 调度 | 含业务 |
| Extensions | `src/extensions/<name>/` | 业务能力,组合 Application + Infra | 跨扩展 import |

### 3.3 扩展模型(Vite-style)

```typescript
defineExtension({
  name: 'memory',
  enforce: 'normal',          // 'pre' | 'normal' | 'post'
  dependsOn: ['trace'],       // 软依赖,影响拓扑顺序
  apply: (ctx) => ({          // ctx: KernelContext
    // 三种通信通道
    provide: { 'memory.store': () => new SQLiteMemoryStore(ctx.profileId) },
    hooks: {
      transformPrompt: async (p, rc) => p.withRecall(await store.recall(rc.turnId)),
    },
    subscribe: {
      'trace.flushed': (evt) => store.ingest(evt),  // 自订阅 Trace
    },
    rpc: { 'memory.search': (q) => store.search(q) },
  }),
})
```

## Kernel 与 Extension 的注册机制

Lobster v2.0 采用 **Vite 风格的链式工厂 + Kahn 拓扑排序** 的两阶段注册模型。

### 1. 注册入口:`kernel.use(ext)` 链式 API

```typescript
// src/interface/daemon/main.ts
import { createKernel } from '@/kernel'
import trace from '@/extensions/trace'
import memory from '@/extensions/memory'
import session from '@/extensions/session'

const kernel = createKernel({ profileId: 'work' })
  .use(trace())              // 'pre'  enforce
  .use(session())            // 'normal'
  .use(memory())             // 'normal',dependsOn: ['trace']
  .use(provider())
  .use(controlplane())       // 'post'

await kernel.start()         // 触发拓扑排序 + apply + kernelReady
```

### 2. Extension 定义:`defineExtension` 工厂

```typescript
// src/extensions/memory/index.ts
import { defineExtension } from '@/kernel'

export default () => defineExtension({
  name: 'memory',
  enforce: 'normal',
  dependsOn: ['trace'],
  apply: (ctx) => {
    const store = new SQLiteMemoryStore(ctx.profileId)
    return {
      provide: { 'memory.store': () => store },
      hooks: {
        transformPrompt: async (prompt, rc) => prompt.withRecall(await store.recall(rc.turnId)),
        onTurnEnd: async (turn) => store.summarize(turn),
      },
      subscribe: { 'trace.flushed': (evt) => store.ingest(evt) },
      rpc: { 'memory.search': (q) => store.search(q) },
      dispose: async () => store.close(),
    }
  },
})
```

### 3. Kernel 内部的三张表

| 表 | 由谁写入 | 用途 |
|---|---|---|
| **ExtensionRegistry**(`Map<name, ExtInstance>`) | apply 阶段 | Capability 解析 |
| **HookContainer**(`Map<hookName, OrderedHandler[]>`) | apply 阶段 | 13 个 hook 的链式执行 |
| **EventBus**(`Map<event, Subscriber[]>`) | apply 阶段 | 解耦广播 |

### 4. 启动时序(`kernel.start()`)

```
① TopoSort(pendingExtensions)
   - Kahn(dependsOn): 入度=0 出队
   - 同层按 enforce: pre→normal→post
   - 同 enforce 内按 name 字典序

② 按排序顺序逐个 invoke ext.apply(ctx)
   - register(name, instance)
   - bind(hooks)
   - subscribe(events)
   - register rpc handlers

③ dispatch('configureKernel') [sequential]

④ dispatch('kernelReady') [parallel]
```

### 5. 三种扩展间通信通道

| 通道 | 用途 | 模式 | 失败语义 |
|---|---|---|---|
| **Hook 链** | 串联式数据加工(prompt / tools / delta) | sequential/parallel/first-match | sequential 中断 turn;parallel 失败隔离 |
| **Capability(provide/consume)** | 引用其他扩展导出的服务 | 同步 get | 缺失抛 CapabilityNotFound |
| **EventBus** | 一对多广播,解耦驱动方向 | pub/sub,异步 | 订阅方失败不影响发布方 |

### 6. 13 个 Hook 与调度模式

| Hook | 模式 | 触发点 |
|---|---|---|
| configureKernel | sequential | Kernel start 前 |
| kernelReady | parallel | 所有扩展 apply 完成 |
| onSessionCreated | parallel | Session 创建 |
| onTurnStart | sequential | turn 进入 RUNNING |
| transformPrompt | sequential | 拼装 prompt |
| resolveTools | sequential | 决定 LLM 可见工具 |
| onToolCall | sequential | 工具执行前后 |
| onLLMDelta | parallel | 流式 token |
| onTurnEnd | parallel | turn 关闭 |
| onTraceEmit | parallel | trace 写入后 |
| onIdentityChanged | parallel | identity diff 落盘 |
| onShutdown | sequential | Kernel stop |
| serveControlMethod | first-match | RPC 路由 |

### 7. 关键不变量

- **INV-Kernel-1**:Kernel 不引用任何 extensions/*
- **INV-Kernel-2**:扩展加载顺序 = Kahn(dependsOn) + enforce(pre→normal→post) + 字典序
- **INV-Kernel-3**:apply 阶段纯登记,IO 延后到 kernelReady
- **INV-Drive-1**:Trace 不知道 Memory/Evolution 存在;只 emit trace.flushed
- **INV-Drive-2**:Memory/Evolution 仅通过 bus 自订阅 trace 事件
- **INV-Ext-Comm-1**:跨扩展 import 由 ESLint no-restricted-paths 编译期阻断

### 8. ControlPlane / DataPlane

| 平面 | 协议 | 传输 | 内容 |
|---|---|---|---|
| ControlPlane | JSON-RPC 2.0 | UnixSocket/InMemory | 24 个方法(session.*/input.*/permission.*/system.*/skills.*/mcp.*/identity.*/evolution.*) |
| DataPlane | NDJSON 流 + cursor | 同传输 | 16 类事件(turn.*/tool.*/llm.delta/trace.flushed/permission.req/identity.changed/session.state/kernel.*) |

### 9. ERD(Domain Model)

```
PROFILE 1:1 DAEMON
PROFILE 1:1 WORKSPACE
PROFILE 1:1 IDENTITY
PROFILE 1:N SESSION
SESSION 1:N TURN
SESSION N:N FRONTEND_BINDING
TURN 1:N TOOL_CALL
TURN 1:N TRACE_EVENT
TURN 1:N PERMISSION_REQ
TRACE_EVENT N:1 MEMORY_ENTRY (异步沉淀)
TRACE_EVENT N:1 EVOLUTION_PROPOSAL (离线扫描)
EVOLUTION_PROPOSAL 1:N IDENTITY_DIFF
IDENTITY 1:N IDENTITY_VERSION
SKILL_DESCRIPTOR 1:N TOOL_CALL
MCP_SERVER 1:N SKILL_DESCRIPTOR
ANCHOR 1:N SESSION (tmux-style)
BOT_ADAPTER N:1 AGENT
```

---

## 4. 16 个扩展子系统

每个扩展卡片:**职责 / Ports / Capabilities / Hooks / Bus / 不变量 / MVP**。

| # | 扩展 | 职责 | 关键 Hook | Bus 发布/订阅 | MVP |
|---|---|---|---|---|---|
| 1 | trace | 写入+广播 trace,单职责 | onTraceEmit | 发布 trace.flushed | JSONL on FS |
| 2 | memory | 沉淀长期记忆+recall | transformPrompt, onTurnEnd | 订阅 trace.flushed | SQLite+naive embedding |
| 3 | skills | 技能描述/注册/提升 | resolveTools | — | 本地 YAML |
| 4 | tools | 本地工具执行(fs/shell/git) | onToolCall, resolveTools | — | 内置工具集 |
| 5 | permission | 用户审批工作流 | onToolCall(pre 拦截) | 发布 permission.req | lastInputFrontendId 路由 |
| 6 | provider | LLM 调用与流式输出 | onLLMDelta | — | OpenAI 兼容+Echo 假实现 |
| 7 | mcp | MCP server 生命周期+skill 注入 | kernelReady, onShutdown, resolveTools | — | stdio transport |
| 8 | identity | 身份版本与回滚 | transformPrompt, onIdentityChanged | — | 版本单调,diff append-only |
| 9 | session | Session 聚合+状态机 | onSessionCreated, onTurnStart, onTurnEnd | — | 状态迁移:INIT→IDLE→RUNNING→WAITING/IDLE→CLOSED |
| 10 | evolution | 离线扫描 trace,产出 identity 提案 | serveControlMethod | 订阅 trace.flushed(节流) | Review 面板 |
| 11 | controlplane | JSON-RPC server,路由到 serveControlMethod | kernelReady, onShutdown | — | 24 个 RPC 方法 |
| 12 | dataplane | NDJSON 事件流广播+cursor 重放 | — | 订阅全部业务事件 | cursor 单调 |
| 13 | transport.unix | UnixSocket 传输 | — | — | 同协议,可替换 InMemory |
| 14 | transport.inmem | InMemory 传输 | — | — | 同协议 |
| 15 | frontend.tui | 终端 UI(Ink),attach/detach/resume | — | 订阅 DataPlane 事件流 | 只读流+输入框 |
| 16 | frontend.lark | 飞书 Bot Adapter,N Bot 共享 Agent | — | — | Bot:Agent=N:1 |

---

## 5. 里程碑(Milestones)

### 5.1 总览

| ID | 名称 | 并行组 | 主要交付 | DoD |
|---|---|---|---|---|
| M-1 | Kernel 框架 | A | Kernel/ExtensionRegistry/HookContainer/EventBus/TopoSort/defineExtension | 空 Kernel 可启停;3 假扩展按拓扑排序触发 13 hooks |
| M-2 | Domain + Application 骨架 | A | domain/* 实体 + application/ports/* + 10 usecase 签名 | 全部纯函数,0 IO 引用;100% 单测 |
| M-3 | trace 扩展 + 驱动反转 | B | extensions/trace,JSONL writer,trace.flushed 广播 | 写入吞吐 ≥ 5k evt/s |
| M-4 | session + provider(Echo) | B | session 状态机+Echo provider+InMemorySessionStore | turn 端到端跑通 |
| M-5 | memory + identity | C | SQLite memory store+identity 版本表+transformPrompt 注入 | trace 沉淀闭环 |
| M-6 | skills + tools + permission | C | 本地 fs/shell/git 工具+审批流 | 审批 frontend 路由命中率 100% |
| M-7 | controlplane + dataplane(InMem) | D | 24 RPC 方法+16 事件类型+InMemory transport | JSON Schema 契约测试通过 |
| M-8 | transport.unix + frontend.tui | E | UnixSocket 传输+Ink TUI+attach/detach/resume | UJ-1,UJ-5 可演示 |
| M-9 | frontend.lark + mcp | E | Lark Bot Adapter+MCP manager | UJ-2 多前端联动 |
| M-10 | evolution + 集成发布 | F | 离线扫描+Review 面板+灰度上线 | UJ-3,UJ-4 通过;MTBF ≥ 7d |

### 5.2 并行编排

```
A: M-1(Kernel) + M-2(Domain/App)  ← 第1周并行
      ↓
B: M-3(trace) + M-4(session/provider)  ← 第2周并行,依赖 A
      ↓
C: M-5(memory+identity) + M-6(skills+tools+permission)  ← 第3周并行,依赖 B
      ↓
D: M-7(CP+DP InMem)  ← 第3周,依赖 A
      ↓
E: M-8(unix+tui) + M-9(lark+mcp)  ← 第4周并行,依赖 D
      ↓
F: M-10(evolution+GA)  ← 第5周,依赖 E
```

---

## 6. 验收门(Release Gate)

v2.0 GA 必须通过:
- ✅ UJ-1 ~ UJ-5 全部演示通过
- ✅ Daemon 7×24 跑满 7 天 MTBF ≥ 7d
- ✅ 首 token ≤ 3s(P50)/ ≤ 6s(P95)
- ✅ ESLint `no-restricted-paths` 0 违规
- ✅ JSON Schema 协议契约测试 100% 通过
- ✅ 17 条 ERD 字段不变量自动化校验全绿

---

## 7. 目标目录结构(v2.0)

```
src/
├── kernel/                    # 轻框架,无业务
│   ├── kernel.ts              # createKernel
│   ├── extension-registry.ts
│   ├── hook-container.ts
│   ├── event-bus.ts
│   ├── topo-sort.ts
│   ├── define-extension.ts
│   ├── kernel-context.ts
│   └── index.ts
├── domain/                    # 纯模型
│   ├── session.ts
│   ├── turn.ts
│   ├── trace-event.ts
│   ├── memory-entry.ts
│   ├── identity.ts
│   ├── skill-descriptor.ts
│   ├── profile.ts
│   └── index.ts
├── application/
│   ├── ports/                 # 端口接口
│   │   ├── trace-writer.ts
│   │   ├── trace-reader.ts
│   │   ├── memory-store.ts
│   │   ├── session-store.ts
│   │   ├── provider.ts
│   │   └── index.ts
│   └── usecases/              # 用例编排
│       ├── submit-turn.ts
│       ├── resolve-tools.ts
│       ├── transform-prompt.ts
│       └── index.ts
├── infrastructure/            # 适配器
│   ├── sqlite-memory-store.ts
│   ├── fs-trace-writer.ts
│   ├── fs-session-store.ts
│   ├── openai-provider.ts
│   └── index.ts
├── extensions/                # 16 个扩展,每个一个目录
│   ├── trace/
│   ├── memory/
│   ├── skills/
│   ├── tools/
│   ├── permission/
│   ├── provider/
│   ├── mcp/
│   ├── identity/
│   ├── session/
│   ├── evolution/
│   ├── controlplane/
│   ├── dataplane/
│   ├── transport.unix/
│   ├── transport.inmem/
│   ├── frontend.tui/
│   └── frontend.lark/
├── interface/
│   ├── daemon/main.ts
│   └── cli/my-agent.ts
├── config/
│   ├── settings.ts
│   ├── schema.ts
│   └── defaults.ts
└── index.ts
```

## 8. Phase 1+2 已完成(前置)

Lobster v2.0 假设以下 Phase 1+2 防腐基线已全部完成:
- 去 Provider registerTools 全局态
- 去 LarkClient 模块单例
- Trace sessionId 注入
- Daemon settings 注入(TOML 双层)
- 全局态清理
- path-validator 白名单全集
- 以上全部 issue 闭合是 Lobster 落地的硬前置

---

---

## 9. LLM 调用单一入口 + Sub-agent Delegate

### 9.1 核心原则

如果 Memory / Evolution / Sub-agent 都各自直连 LLM,会出现:
- 多份 Provider 客户端、Token 计费分散
- 绕过 Identity / Permission / Trace,变成"暗管线"
- Sub-agent 与主 Agent 共享上下文困难
- Profile 切换时多个客户端要逐个清理

**解法**:所有 LLM 调用必须经过 `provider` 扩展暴露的 capability,并以"内部 Turn"形式记账。

### 9.2 唯一入口:`provider.chat` + `provider.invoke`

```ts
// src/extensions/provider/index.ts
export default () => defineExtension({
  name: 'provider',
  enforce: 'pre',
  apply: (ctx) => {
    const client = new OpenAICompatClient(ctx.config.provider)
    return {
      provide: {
        // ① 业务 turn 用(经过完整 hook 链)
        'provider.chat': () => ({
          stream: (req: ChatRequest) => runWithHooks(ctx, req),
        }),
        // ② 内部用(轻量,不走 hook 链,但仍记 trace)
        'provider.invoke': () => ({
          call: (req: InvokeRequest) => runInternal(ctx, req),
        }),
      },
    }
  },
})
```

| 模式 | Capability | 经过 Hook 链 | 记 Trace | 计入 Session | 典型场景 |
|---|---|---|---|---|---|
| 业务 Turn(主 Agent) | `provider.chat` | ✅ 完整 13 hooks | ✅ | ✅ | 用户输入触发的对话 |
| 内部调用(Memory/Evolution) | `provider.invoke` | ❌ 仅 `onTraceEmit` | ✅(kind=internal) | ❌(挂在虚拟 InternalTurn) | 摘要、提案、embedding |
| Sub-agent Turn | `provider.chat` + `subTurnOf` | ✅(子 Hook 链) | ✅(parentTurnId 关联) | ✅(SubTurn 子聚合) | 工具型代理、并行规划 |

**INV-Provider-1**:全工程仅 `provider` 扩展持有真正的 LLM 客户端,其余扩展只能通过 capability 获取。ESLint `no-restricted-imports` 禁止任何文件直接 import LLM SDK。

### 9.3 Memory 摘要场景

```ts
// src/extensions/memory/index.ts
apply: (ctx) => {
  const store = new SQLiteMemoryStore(ctx.profileId)
  const invoke = () => ctx.extensions.get<ProviderInvoke>('provider.invoke')

  return {
    subscribe: {
      'trace.flushed': async (evt) => {
        store.ingestRaw(evt)
        if (evt.type === 'turn.end') {
          const raw = await store.fetchTurnRaw(evt.turnId)
          const { content, usage } = await invoke().call({
            kind: 'internal',
            purpose: 'memory.summarize',    // Trace 归类与配额
            parentTurnId: evt.turnId,       // 关联业务 turn
            messages: buildSummaryPrompt(raw),
            maxTokens: 512,
            model: ctx.config.memory.model ?? 'small',
          })
          await store.writeSummary(evt.turnId, content)
          ctx.bus.emit('memory.summarized', { turnId: evt.turnId, usage })
        }
      },
    },
  }
}
```

### 9.4 Evolution 提案场景

```ts
// src/extensions/evolution/index.ts
apply: (ctx) => {
  const invoke = () => ctx.extensions.get<ProviderInvoke>('provider.invoke')
  const reader = () => ctx.extensions.get<TraceReader>('trace.reader')
  const id = () => ctx.extensions.get<IdentityStore>('identity.store')

  const tick = throttle(async () => {
    const window = await reader().scan({ since: lastCursor })
    const { content } = await invoke().call({
      kind: 'internal',
      purpose: 'evolution.propose',
      messages: buildProposalPrompt(window, await id().current()),
      maxTokens: 2048,
      model: ctx.config.evolution.model ?? 'large',
    })
    const proposal = parseProposal(content)
    await proposalRepo.save(proposal)
    ctx.bus.emit('evolution.proposal.created', { id: proposal.id })
  }, 60 * 60 * 1000)

  return {
    subscribe: { 'trace.flushed': () => tick() },
    rpc: {
      'evolution.list': () => proposalRepo.list(),
      'evolution.approve': (id) => approveAndApply(id),
    },
  }
}
```

### 9.5 内部调用的关键设计点

| 设计点 | 解释 |
|---|---|
| `provider.invoke` 不走 hook 链 | 否则 Memory 的 `transformPrompt` 会再注入 recall,可能递归 |
| `purpose` 字段 | trace 中标 `purpose=memory.summarize`,便于配额、审计、关停 |
| `parentTurnId` 关联 | 业务 turn 和派生调用形成有向链,Trace Reader 可聚合查看真实成本 |
| 节流+攒批 | Memory 按 turn 边界,Evolution 按时间窗,避免 trace 风暴时雪崩 LLM |
| 独立 model 配置 | `memory.model` 用小模型,`evolution.model` 用大模型,节省成本 |
| 失败隔离 | 内部 LLM 调用失败不影响业务 turn——bus 订阅本身就是失败隔离的 |

### 9.6 Sub-agent Delegate → SubTurn 聚合

Sub-agent 在 Lobster v2.0 中被建模为 **`agent-as-tool`** 模式,触发 Session 下的 SubTurn:

```ts
// src/extensions/skills/built-in/sub-agent.ts
defineSkill({
  name: 'delegate',
  description: 'Delegate a focused subtask to a sub-agent',
  parameters: { task: 'string', toolsAllowed: 'string[]?' },
  async invoke({ task, toolsAllowed }, ctx) {
    const sub = await ctx.session.startSubTurn({
      parentTurnId: ctx.turnId,
      systemPrompt: buildSubAgentPrompt(task),
      toolWhitelist: toolsAllowed ?? defaultToolset,
    })
    const result = await sub.run()
    return { result: result.finalMessage, usage: result.usage }
  },
})
```

**SubTurn 与主 Turn 的资源关系**:

| 维度 | 主 Turn | SubTurn |
|---|---|---|
| LLM 客户端 | 同一 `provider.chat`(共享) | 同一(共享) |
| Memory recall | 注入 | 默认注入,可关闭(`recall: false`) |
| Identity 注入 | 完整 system prompt | 子角色叠加(`subAgentSystem`) |
| Permission | 用户审批 | 默认继承父 turn 已审批工具,新工具仍弹窗 |
| Tool 集合 | 全集 | `toolWhitelist` 收窄 |
| Trace | `turnId` | `turnId` + `parentTurnId` |
| 计费/成本归集 | 按 turn 聚合 | rollup 到 parent turn |
| 流式输出 | 推送给前端 | 默认不推前端,只回写 tool result |

**SubTurn 不变量**:
- **INV-SubTurn-1**:SubTurn 必须挂在某个 Turn 之下
- **INV-SubTurn-2**:SubTurn 共享父 Turn 的 permission 上下文,但有独立 messages 与 tool 子集
- **INV-SubTurn-3**:SubTurn trace 事件 `parentTurnId` 指向父 turn,用于成本/链路聚合
- **INV-SubTurn-4**:`subTurnDepth ≤ maxSubTurnDepth`(默认 3)
- **INV-SubTurn-5**:单父 turn 并发 SubTurn ≤ `maxParallelSubTurns`(默认 4)
- **INV-SubTurn-6**:SubTurn timeout 不卡死父 turn,返回 `delegate.timeout` tool error

### 9.7 LLM 调用总图

```
主 Turn ──→ provider.chat ──→ LLM Client ──→ Trace(完整 hook 链)
SubTurn ──→ provider.chat ──→ LLM Client ──→ Trace(parentTurnId)
Memory  ──→ provider.invoke ──→ LLM Client ──→ Trace(purpose=memory.*)
Evolution ─→ provider.invoke ──→ LLM Client ──→ Trace(purpose=evolution.*)
```

---

## 10. Runtime 生命周期钩子 + Middleware 迁移

### 10.1 原架构回顾:Koa 风格洋葱 Middleware

```ts
// 旧架构
runtime.use(loggingMw)
runtime.use(rateLimitMw)
runtime.use(traceMw)
runtime.use(promptInjectMw)

async function loggingMw(ctx, next) {
  const t0 = Date.now()
  try { await next() } finally { log({ dur: Date.now() - t0 }) }
}
```

**旧架构的问题**:
- middleware 与 runtime 强耦合,顺序由 `use()` 调用顺序决定,难以可视化
- 同一 middleware 想横跨"prompt 拼装、LLM 流、工具调用"三个相位需内部判断 `ctx.phase`
- 失败语义混乱:洋葱模型默认串联中断,parallel 旁路场景需自行处理
- 无法独立测试单个 middleware 的某一相位

### 10.2 新架构:Hook 链 = Middleware 的"切片化"

> **旧 middleware = 多个新 hook 的横切组合**;`next()` 语义被替换为 **sequential hook 的 payload 串联传递**。

### 10.3 旧 Hook → 新 Hook 对应表

| 旧 runtime 钩子 | 新 Hook | 调度模式 | 典型迁移点 |
|---|---|---|---|
| `runtime.init` | `configureKernel` | sequential | 配置注入、feature flag |
| `runtime.ready` | `kernelReady` | parallel | 启动 server、订阅 bus |
| `beforeTurn` | `onTurnStart` | sequential | 请求 ID、租户解析 |
| `beforeLLM`(prompt) | `transformPrompt` | sequential(payload 串联) | prompt 注入、recall、敏感词过滤 |
| `beforeLLM`(tool) | `resolveTools` | sequential | 工具白名单收窄、按角色筛选 |
| `afterLLM`(流式) | `onLLMDelta` | parallel | 流量统计、关键词监控 |
| `beforeTool/afterTool` | `onToolCall`(pre/post) | sequential | 审批拦截、结果脱敏 |
| `afterTurn` | `onTurnEnd` | parallel | 摘要触发、计费汇总 |
| `onTrace` | `onTraceEmit` | parallel | 自定义 sink |
| `onError` | 各 hook 抛错+errors.ts 统一映射 | — | 错误码归一化 |
| `onAbort` | `onTurnEnd`(state=ABORTED) | parallel | 资源回收 |
| `onShutdown` | `onShutdown` | sequential | 优雅停机 |
| 自定义 RPC | `serveControlMethod` | first-match | RPC 路由 |
| 身份变更 | `onIdentityChanged` | parallel | 缓存失效、bus 广播 |
| Session 创建 | `onSessionCreated` | parallel | per-session 初始化 |

### 10.4 三种典型 Middleware 形态迁移

#### 形态 A:横切 Logging/计时(只关心进出)

旧:
```ts
runtime.use(async (ctx, next) => {
  const t0 = Date.now()
  await next()
  ctx.trace.log({ dur: Date.now() - t0 })
})
```

新(`onTurnStart` + `onTurnEnd` 配对,parallel 失败隔离):
```ts
defineExtension({
  name: 'logging',
  enforce: 'pre',
  apply: (ctx) => {
    const timers = new Map<string, number>()
    return {
      hooks: {
        onTurnStart: (turn) => { timers.set(turn.id, ctx.clock.now()) },
        onTurnEnd:   (turn) => {
          const dur = ctx.clock.now() - (timers.get(turn.id) ?? 0)
          ctx.bus.emit('metrics.turn.duration', { turnId: turn.id, dur })
        },
      },
    }
  },
})
```

#### 形态 B:数据加工 middleware(改写 prompt / tool 集合)

旧:
```ts
runtime.use(async (ctx, next) => {
  ctx.prompt = injectRecall(ctx.prompt, await memory.recall(ctx))
  await next()
})
```

新(sequential `transformPrompt` 串联 payload,取代 `next()`):
```ts
hooks: {
  transformPrompt: {
    enforce: 'normal',
    fn: async (prompt, runCtx) =>
      prompt.withRecall(await store.recall(runCtx.turnId)),
  },
}
```
> sequential 模式下 Kernel 自动把上一段返回值作为下一段输入,不再需要显式 `next()`。

#### 形态 C:控制流 middleware(可中断/重试)

旧:
```ts
runtime.use(async (ctx, next) => {
  if (!await permission.check(ctx)) throw new PermissionDenied()
  await next()
})
```

新(`onToolCall` pre 段抛错,Kernel 映射为 tool.error 继续 turn):
```ts
hooks: {
  onToolCall: {
    enforce: 'pre',
    fn: async (call, rc, ctx) => {
      const ok = await ctx.extensions.get('permission.checker').check(call)
      if (!ok) throw new PermissionDenied(call.id)
    },
  },
}
```

### 10.5 完整迁移示例:`rateLimitMw`

旧:
```ts
runtime.use(async (ctx, next) => {
  await tokenBucket.acquire(ctx.userId)
  try { await next() } finally { tokenBucket.release(ctx.userId) }
})
```

新(扩展形态):
```ts
// src/extensions/rate-limit/index.ts
export default () => defineExtension({
  name: 'rate-limit',
  enforce: 'pre',
  apply: (ctx) => {
    const bucket = new TokenBucket(ctx.config.rateLimit)
    return {
      provide: { 'rate-limit.bucket': () => bucket },
      hooks: {
        onTurnStart: async (turn) => { await bucket.acquire(turn.userId) },
        onTurnEnd:   (turn)        => { bucket.release(turn.userId) },
      },
      rpc: {
        'rate-limit.status': (uid) => bucket.snapshot(uid),
      },
    }
  },
})
```

收益:
- 顺序由 `enforce: 'pre'` 显式保证,不再依赖 `use()` 调用次序
- `acquire`/`release` 拆到两个 parallel hook,失败不污染 turn 主流程
- 暴露 capability 和 RPC,可观测、可复用
- 单元测试只需 mock `onTurnStart` 入参,不构造完整 ctx

### 10.6 旧 Middleware 优缺点的保留与修正

| 旧 Middleware 优点 | 新 Hook 链如何保留 |
|---|---|
| 顺序可控 | `enforce: pre/normal/post` + `dependsOn` 拓扑 + `order` 微调 |
| `next()` 串联 | sequential 模式自动 payload 传递 |
| 包裹式逻辑(try/finally) | 同名扩展同时注册 pre 与 post,语义等价 |
| 任意拦截 | sequential hook 中抛错即中断该相位;Kernel 统一映射错误码 |
| 共享 ctx | `KernelContext` + `RunContext`(per-turn) 双层注入 |

| 旧 Middleware 缺点 | 新 Hook 链的修正 |
|---|---|
| 一个洋葱跑全相位 | 13 个相位独立 hook,职责单一 |
| 失败语义不清 | 每个 hook 显式声明 sequential/parallel/first-match |
| 顺序靠 use() 调用顺序 | 拓扑排序+enforce+order 三层显式声明 |
| 无法独立测试某相位 | 单个 hook 可独立 mock RunContext 测试 |
| 跨扩展复用难 | hook + capability + bus 三通道 |

### 10.7 Hook 不变量

- **INV-Hook-1**:任一 hook 的执行模式由 Kernel 静态决定,扩展不可运行时改变
- **INV-Hook-2**:sequential hook 抛错即中断该相位,Kernel 归一为 `Kernel.HookFailure` 记入 trace
- **INV-Hook-3**:parallel hook 失败相互隔离,聚合写入 trace 但不中断 turn
- **INV-Hook-4**:同名扩展可同时注册同一 hook 的 pre/normal/post 三段,等价 try/finally 语义
- **INV-Hook-5**:hook 实现禁止跨扩展直接 import;只能通过 `ctx.extensions.get`/`ctx.bus` 访问

### 10.8 一句话总结

> **旧 middleware 是"一根洋葱跑全部相位",新 hook 链是"13 个相位 × 三段 enforce 的切片"**;sequential hook 的 payload 串联取代了 `next()`,parallel 模式带来了原 middleware 不具备的失败隔离能力,而"包裹/拦截/改写"三种能力分别由 pre+post 配对、sequential 抛错中断、sequential payload 加工一一对应保留。

---

## 附录 A · JSON Schema 索引
- `controlplane/methods/*.json`(24 个)
- `dataplane/events/*.json`(16 个)
- `domain/*.json`(Session/Turn/TraceEvent/Identity/Profile/...)

## 附录 B · 文档历史

| 版本 | 日期 | 变更 |
|---|---|---|
| v2.0-final | 2026-05-17 | 终稿:Kernel+Extensions(Vite-style)+DDD 四层+10 里程碑 |
| v2.0 | 2026-05-17 | 新增 §9(LLM 单一入口+SubTurn)、§10(Hook 链+Middleware 迁移) |
