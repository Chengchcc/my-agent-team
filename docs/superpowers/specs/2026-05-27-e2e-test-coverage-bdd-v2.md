---
title: End-to-End Test Coverage — BDD/TDD Spec (v2)
date: 2026-05-27
status: ready-for-implementation
methodology: BDD-first (Given/When/Then) with TDD per scenario (Red → Green → Refactor)
author: 程晨
supersedes: 2026-05-26-e2e-test-coverage-bdd-design.md (v1)
related:
  - 2026-05-26-contractbus-envelope-sessionid-fix-design.md
  - 2026-05-26-g2-contractbus-residual-migration-patch-design.md
  - 2026-05-26-lobster-v2.1-architectural-governance-design.md
  - 2026-05-26-project-wide-bug-audit-design.md
---

# E2E Test Coverage — Lobster v2.0 (v2)

## 0. 立项依据

### 0.1 测试基线现状

```
tests/                   总 96 个 .test.ts
├── domain/              纯 invariants
├── application/         纯 usecase + ports
├── extensions/          单 extension 隔离
├── kernel/              extension wiring 单测
└── interface/
    └── daemon-bootstrap.test.ts   ← 唯一接近 e2e,只验证 bootstrap+stop,不跑 turn
```

零端到端 case,所有"跨层装配后的真实行为"都没有兜底。

### 0.2 为什么需要 e2e

近两天三个 bug 全部 unit 测得过、装配链路才挂:

| Bug | Unit 是否报 | 表现 |
|---|---|---|
| ContractBus envelope sessionId 丢失 | 不报(`run-turn` / `dataplane` / `frontend.lark` 各自单测 GREEN) | Lark card "未返回内容" |
| G2 残留 6 处裸 `bus.emit` | 不报 | dataplane silent drop |
| P2P sessionId='main' 共享 | 不报 | 不同用户串话 |

→ 缺一条"装配后的真实可观察行为"的安全网。

### 0.3 范围

- **In-scope**:`createKernel()` + 真实 `presets` 装配出的完整 18 extension 拓扑;真 ContractBus / 真 dataplane / 真 session / 真 turn-runner;3 个边界 Fake(LLM / Lark / agent.store)。
- **Out-of-scope**:真模型 API、真 Lark WS、真终端渲染 — 归 nightly canary,本 spec 不写。

---

## 1. 测试金字塔与术语

### 1.1 三层装配,匹配三类目的

```
┌──────────────────────────────────────────────┐
│  L3  full bootstrap() — 测 daemon 自己        │ ← F1
│      真 SqliteAgentStore + FileLogger + seed   │
│      ~3 cases, ~3s/case                        │
├──────────────────────────────────────────────┤
│  L2  presets + createKernel() — 测装配后行为   │ ← F2~F9 主战场
│      真 18 extensions + 真 ContractBus          │
│      Fake: provider.llm, lark.channel, agent.store│
│      ~25 cases, ~300ms/case                    │
├──────────────────────────────────────────────┤
│  L1  createTestKernel() — 单 extension 行为    │ ← 已有 96 unit
│      手挑 1-3 extension                         │
└──────────────────────────────────────────────┘
```

L2 不是"裁剪版 bootstrap",是"真实 preset 组装 + 替换 3 个边界 port"。

### 1.2 BDD 词汇

| 术语 | 定义 |
|---|---|
| Feature | 一项用户/外部可观察能力 |
| Scenario | 一个 Given/When/Then 三段式行为 |
| Step | `given(desc, fn)` / `when(desc, fn)` / `then(desc, fn)` 描述 + 断言 |
| Fixture | 满足 Given 的复用装配(`bootE2E`、`E2EFakeProvider` 等) |

文件命名:`tests/e2e/<feature>.spec.ts`;case 描述形如 `it('Scenario X.Y: Given ... When ... Then ...')`。

---

## 2. Feature 矩阵

9 Feature × 平均 3 Scenario ≈ 27 cases。

| # | Feature | Scenarios | 优先级 | PR |
|---|---|---|---|---|
| F1 | Bootstrap & shutdown (L3) | cold start / idempotent stop / socket path guard | P0 | PR-2 |
| F2 | TUI single-turn (L2) | single text turn / streamed deltas / provider error | P0 | PR-2 |
| F3 | Lark p2p single-turn (L2, 回归) | "未返回内容" / single terminal / user isolation | P0 | PR-3 |
| F4 | Multi-turn history | 2nd turn sees 1st | P1 | PR-4 |
| F5 | Tool wave | 2 parallel tools / one fails | P1 | PR-4 |
| F6 | Abort mid-turn | cancel cascades to provider+tool | P1 | PR-4 |
| F7 | Sub-agent | main→sub→results to main | P1 | PR-4 |
| F8 | Auto-compact | threshold triggers, turn continues | P2 | PR-4 |
| F9 | Single source of truth for terminals (回归) | exactly 1 terminal per turn | P0 | PR-3 |

---

## 3. 装配模型 (L2)

### 3.1 总体结构

```
bootE2E(opts)
  ├─ createKernel({ silentLogger, tmp agentDir })
  ├─ provideKernel('agent.store', new InMemoryAgentStore())          ← W0.a
  ├─ provideKernel('lark.channel.factory', FakeLarkChannelFactory)   ← W0.b (if withLark)
  ├─ provideKernel('lark.client.factory',  FakeLarkClientFactory)    ← W0.b (if withLark)
  ├─ use(...presets, EXCEPT 'provider')
  ├─ use(e2eProvider(fakeLLM))           ← 顶替真 provider 扩展,占用相同 name
  ├─ use(...opts.fakeTools.map(toExt))   ← enforce: 'post', dependsOn: ['tool-catalog']
  ├─ use(captureExtension)               ← enforce: 'post', monkey-patch ctx.bus.emit
  ├─ await kernel.start()
  ├─ transport = kernel.ctx.extensions.get('transport-inmem.transport')
  ├─ client    = new SessionClient(transport, 'e2e-tui')
  ├─ client.sendRpc('hello', { ... })    ← 握手,确保 dataplane 订阅
  └─ return { kernel, client, fakeLLM, fakeChannel?, larkAdapter?, captured, waitFor, stop }
```

### 3.2 三个被 Fake 的边界

| 能力 | 注入通道 | 生产入口 | E2E 入口 |
|---|---|---|---|
| `agent.store`(新抽 port) | `provideKernel` | `bootstrap()` 装 SqliteAgentStore | `bootE2E()` 装 `InMemoryAgentStore` |
| `lark.channel.factory`(新抽 port) | `provideKernel` | `bootstrap()` 装 vendor WS 工厂 | `bootE2E()` 装 FakeLarkChannelFactory |
| `lark.client.factory`(新抽 port) | `provideKernel` | `bootstrap()` 装 vendor HTTP 工厂 | `bootE2E()` 装 FakeLarkClientFactory |
| `provider.llm` | **extension 替换** | `provider` 扩展 register Claude/OpenAI/Echo | `e2eProvider(fakeLLM)` 顶替真 `provider` 扩展(同名) |

**设计原则 (GG-X)**:环境依赖型单例(store、external WS/HTTP client、registry/selfMutator)走 `provideKernel`;业务能力扩展走 `provide`。

### 3.3 装配顺序硬约束

```
createKernel()
  ↓
provideKernel(...)      ← 必须在任何 kernel.use(...) 之前
  ↓
kernel.use(...presets)  ← 真 provider 已被剔除
  ↓
kernel.use(e2eProvider) ← name='provider', 占位
  ↓
kernel.use(fakeTools)
  ↓
kernel.use(capture)     ← enforce:'post' 确保最后
  ↓
kernel.start()
```

---

## 4. 共享 Fixtures (W0.c ~ PR-1)

### 4.1 `tests/e2e/_fixtures/boot-kernel.ts`

核心装配函数,返回 `E2EHandle { kernel, client, fakeLLM, fakeChannel, fakeLarkClient, larkAdapter, captured, waitFor, stop }`。

### 4.2 `tests/e2e/_fixtures/e2e-fake-provider.ts`

`E2EFakeProvider implements ProviderChat` — 独立于 `tests/fixtures/fake-provider.ts`,不影响现有 96 unit。Yields 真实 `ChatResponseChunk` union(`{ type: 'text', delta }` / `{ type: 'tool_call_start', toolCall }` / `{ type: 'usage', usage }` / `{ type: 'done' }`)。支持 multi-turn(`turnCursor`自增)、`receivedRequests` 记录(F4 断言)、`abortObserved`(F6 断言)、`errorAfter`(F2.3/F6)。

### 4.3 `tests/e2e/_fixtures/fake-lark-channel.ts`

`FakeLarkChannel` — 只实现 `send/openCard/updateCard/addReaction/removeReaction/on/disconnect`。`lastCardState()` 提供卡片文本与状态探查,供 F3 回归断言。

### 4.4 `tests/e2e/_fixtures/fake-lark-client.ts`

Skinny stub for HTTP calls (replyMessage / sendCard) — 方法列表在 W0.b 落地时确定。

### 4.5 `tests/e2e/_fixtures/in-memory-agent-store.ts`

实现 `agent.store` port(~80 LOC):`get/create/update/list/setLark/...`,与 SqliteAgentStore 同接口。契约一致性用 parity smoke 守护。

### 4.6 `tests/e2e/_fixtures/fake-tool.ts`

`makeFakeTool(spec: FakeToolSpec): Tool` — 注册到真 `tool-catalog.catalog`,走真 dispatch 链;支持 `handler`(同步/async)、`delayMs`(wave 时序测试)。

### 4.7 `tests/e2e/_fixtures/event-asserts.ts`(替代 FakeTuiRenderer)

```ts
assistantText(buf, sid): string        // 拼接所有 assistant.delta
terminalCount(buf, sid): number         // turn.completed + turn.failed 计数
eventsWithoutSessionId(buf, prefix)     // 防 envelope sessionId 丢失回归
eventsAfter(buf, cursor, predicate)     // 从某点往后过滤
```

### 4.8 `tests/e2e/_fixtures/dsl.ts`

`given(desc, fn)` / `when(desc, fn)` / `then(desc, fn)` — 语义糖,返回 Promise。

---

## 5. BDD Scenarios (完整列表)

### F1 — Daemon lifecycle (L3, 走真 bootstrap)

文件:`tests/e2e/daemon-lifecycle.spec.ts`

```
Scenario 1.1: cold start with inmem transport
  Given a fresh temp agent home
  When bootstrap({ transport:'inmem' })
  Then handle.kernel started
  And 18 extensions loaded

Scenario 1.2: stop is idempotent
  Given a started kernel
  When stop() twice
  Then both resolve without throwing

Scenario 1.3: socket path length guard
  Given agentId longer than 100 chars
  When bootstrap({ transport:'unix' })
  Then rejects with "socket path too long"
```

### F2 — TUI single-turn (L2, 走 SessionClient)

文件:`tests/e2e/tui-single-turn.spec.ts`

```
Scenario 2.1: single text-only turn
  Given bootE2E + llmTurns=[{ textDeltas:['hello back'], usage:{1,2} }]
  When client.createSession() then client.sendInput(sid, 'hi')
  Then waitFor turn.completed with sessionId=sid (<2s)
  And assistantText(captured, sid) === 'hello back'
  And terminalCount(captured, sid) === 1
  And eventsWithoutSessionId(captured, 'assistant.') is empty

Scenario 2.2: streamed deltas concatenate
  Given llmTurns=[{ textDeltas:['hel','lo ','back'] }]
  When sendInput
  Then captured assistant.delta count >= 3
  And final concatenation === 'hello back'

Scenario 2.3: provider throws mid-stream
  Given llmTurns=[{ textDeltas:['hi'], errorAfter:1 }]
  When sendInput
  Then turn.failed fires exactly once
  And captured contains no turn.completed for sid
```

### F3 — Lark p2p single-turn (L2 + larkAdapter, 回归)

文件:`tests/e2e/lark-p2p.spec.ts`

```
Scenario 3.1: hi → reply (regression for "未返回内容")
  Given bootE2E({withLark:true, llmTurns:[{ textDeltas:['hello back'] }]})
  When larkAdapter.handleMessage({kind:'lark-p2p',userId:'uid1',appId:'fake'}, 'hi', 'chat-1', 'msg-1')
  Then waitFor turn.completed (<2s)
  And fakeChannel.lastCardState().text === 'hello back'
  And fakeChannel.lastCardState().status === 'done'
  And eventsWithoutSessionId(captured, 'assistant.') is empty

Scenario 3.2: only one terminal reaches lark adapter per turn
  Given setup of 3.1
  When turn completes
  Then terminalCount(captured, sid) === 1

Scenario 3.3: two p2p users get isolated sessions
  Given bootE2E({withLark:true, llmTurns:[{textDeltas:['A']},{textDeltas:['B']}]})
  When uid1 + uid2 push 'hi' concurrently
  Then 2 distinct sessions in store
  And each receives only their own reply
```

### F4 — Multi-turn history

```
Scenario 4.1: second turn sees first turn
  Given llmTurns=[{textDeltas:['ack1']},{textDeltas:['ack2']}]
  When sendInput('my name is alice') then sendInput("what's my name?")
  Then fakeLLM.receivedRequests[1].messages contains 'my name is alice'
```

### F5 — Tool wave

```
Scenario 5.1: two parallel tools in one wave
  Given fakeTools=[{name:'tool_A',handler:()=>'okA'},{name:'tool_B',handler:()=>'okB'}]
  And llmTurns=[{toolCalls:[A,B]},{textDeltas:['done']}]
  When sendInput('trigger')
  Then exactly one wave.completed with callsInWave===2
  And assistantText final === 'done'

Scenario 5.2: one of two parallel tools fails
  Given tool_B handler throws
  When sendInput
  Then wave.completed still has callsInWave===2
  And tool.error fired once for tool_B
  And turn still reaches completed
```

### F6 — Abort mid-turn

```
Scenario 6.1: abort during stream
  Given llmTurns=[{textDeltas:['a','b','c',...]}] each via 10ms delay
  When after 5th delta, client.sendRpc('input.cancel', {sessionId:sid})
  Then within 500ms turn.failed fires with stage='aborted'
  And fakeLLM.abortObserved === true
  And no assistant.delta arrives after cancel cursor
```

### F7 — Sub-agent

```
Scenario 7.1: happy path
  Given Task tool registered; main LLM calls Task({prompt:'sub'}); sub LLM replies 'sub-done'
  When sendInput('go')
  Then main assistantText contains 'sub-done'
  And sub session is ephemeral
```

### F8 — Auto-compact

```
Scenario 8.1: compact mid-turn at threshold
  Given session preloaded with history ≈ COMPACT_AUTO_THRESHOLD_TOKENS+100
  And fakeCompactor via provideKernel('session.compactor', fake)
  When sendInput('new turn')
  Then fakeCompactor.calls === 1
  And new turn reaches completed
```

### F9 — Single source of truth for terminals (回归)

```
Scenario 9.1: no shadow terminals across all happy-path setups
  Given any of F2.1 / F3.1 / F4 / F5.1
  When the turn completes
  Then terminalCount(captured, sid) === 1
  And every terminal envelope has non-undefined sessionId and turnId
```

---

## 6. TDD 流程 (per scenario)

每 Scenario 三步走,严格三 commits:

1. **RED** — 写测试,确认失败。
2. **GREEN** — 最小改动让它通过(修 fixture / 修 prod / 调装配)。
3. **REFACTOR** — 提炼 Given/When 到 `_fixtures/`,不改断言。

例外:F1 已部分覆盖 → 直接 GREEN + REFACTOR;F3/F9 是回归 → 必须先在当前 main RED 才能合 fix。

---

## 7. 实施排期 (4 个 PR, ~2.5 天)

| PR | 内容 | 估时 | 阻塞 |
|---|---|---|---|
| **PR-1** | W0.c 骨架: bootE2E + DSL + event-asserts + waitFor + E2EFakeProvider + smoke | 0.25d | — |
| **PR-2** | W0.a agent.store port + InMemoryAgentStore + F1(3) + F2(3) | 0.75d | PR-1 |
| **PR-3** | W0.b lark seam + F3(3) + F9(1) + sessionId fix 3 prod edits | 0.75d | PR-2 |
| **PR-4** | F4-F8 + fake-tool + README + CI接入 + ARCH GG-X | 0.75d | PR-3 |

---

## 8. CI 集成

```jsonc
// package.json
{
  "scripts": {
    "test:unit": "bun test tests/{domain,application,extensions,kernel,infrastructure,interface,mcp,schema,shared,skills,tui,utils,contracts,config}",
    "test:e2e":  "bun test tests/e2e --timeout 10000",
    "test:all":  "bun run test:unit && bun run test:e2e",
    "check:all": "bun run typecheck && bun run lint && bun run arch && bun run deadcode && bun run test:all"
  }
}
```

| 入口 | 跑什么 |
|---|---|
| pre-push | `check:all` 含 e2e |
| CI on PR | `check:all` 强制 |
| 本地 escape | `SKIP_E2E=1 git push` |

---

## 9. Definition of Done

- [ ] PR-1: `_fixtures/` 骨架 + smoke GREEN
- [ ] PR-2: F1 + F2 全 GREEN; agent.store 走 provideKernel
- [ ] PR-3: F3 + F9 RED→GREEN; lark seam 抽取
- [ ] PR-4: F4-F8 全 GREEN; CI 接入; GG-X 条款
- [ ] 全套 `bun run test:e2e` <2min

---

## 10. Open Questions (留待后续)

1. 真模型 canary — nightly 跑 1-2 真 turn,本期不实现
2. 真终端渲染快照 — ink-testing-library, phase-2
3. 跨 daemon 并发 — phase-2
4. Lark dispatcher 解析层(去重/self-skip/mention) — 本期绕过,未来 F10
