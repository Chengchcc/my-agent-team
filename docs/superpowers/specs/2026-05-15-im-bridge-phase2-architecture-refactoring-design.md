# IM-Bridge Phase 2: Architecture Refactoring + Independent Bug Fixes

**Date:** 2026-05-15
**Status:** approved
**Scope:** 3 root-cause refactors + 75 independent bugs = 78 bugs total, ~340 production lines, ~62 test cases (~720 lines)

---

## 1. Complete Bug Inventory (Phase 2)

### 1.1 Root Cause Refactors (3 bugs)

| ID | P | File:Line | Problem |
|---|---|---|---|
| #54 | P0 | session-manager.ts:78 | Every createSession calls createAgentRuntime (full rebuild) |
| #23 | P0 | daemon.ts:60 | currentSessionRef global mutable ref, cross-session race |
| #60 | P0 | client.ts:4-6 | Module-level _client/_appId/_appSecret singleton |

### 1.2 Cascade Bugs (9 bugs, blocked by root refactors)

| ID | P | Problem | Blocked By |
|---|---|---|---|
| #51 | P1 | MCP repeated connect → port exhaustion | #54 |
| #53 | P1 | Skills repeated disk scan | #54 |
| #82 | P0 | SqliteMemoryStore multiple WAL open → SQLITE_BUSY | #54 |
| #83 | P0 | provider.registerTools cross-session overwrite → wrong tools | #54 |
| #26 | P1 | Repeated tenant_access_token pull, amplified by #54 | #54 |
| #1 | P0 | Card streaming module-level let, cross-session stream interleave | #23 |
| #3 | P0 | sendPermissionCard directly returns 'deny', never awaits user | #23 |
| #4 | P1 | onReload only updates "current" agent, stale system prompt | #23 |
| #52 | P0 | PermissionManager.subscribe overwrites previous subscriber | #23 |

### 1.3 Independent Bugs — Group E (Lark Client, 9 bugs)

| ID | P | Problem |
|---|---|---|
| #5 | P0 | allowedUsers ACL not actually enforced |
| #9 | P1 | getChatMode 5min cache no invalidation |
| #28 | P0 | Topic mode routing uses messageId instead of threadId |
| #46 | P0 | WS reconnect uses expired token |
| #47 | P1 | Event handler exception disconnects WS |
| #27 | P2 | HTTP retry no jitter |
| #67 | P2 | Chat disband event no cleanup |
| #70 | P2 | botSetup doesn't validate app_id regex |
| #78 | P0 | allowedUsers compares email, dispatcher compares open_id |

### 1.4 Independent Bugs — Group F (Routing & Session Lifecycle, 17 bugs)

| ID | P | Problem |
|---|---|---|
| #2 | P0 | /close removeSession missing larkAppId in key |
| #37 | P1 | removeSession doesn't abort running turn |
| #15 | P0 | handleNewTopic rootMessageId uses messageId, not thread.root_id |
| #16 | P1 | handleThreadReply anchor miswired when reply_in_thread |
| #7 | P1 | No event_id dedup |
| #8 | P2 | @other_bot also triggers dispatch |
| #14 | P2 | session_id payload no nullcheck |
| #34 | P0 | session_id empty → picks arbitrary session |
| #17 | P2 | setupCardCallbacks duplicate binding |
| #44 | P1 | profile.workingDir not created, no error |
| #69 | P1 | Reply card failure leaves session stuck |
| #6 | P2 | Self-message filter only allows /close |
| #29 | P2 | Message recall event not handled |
| #35 | P2 | Duplicate button click not idempotent |
| #38 | P2 | sessionStore write no fsync |
| #48 | P2 | Flush queue leaks after session remove |
| #39 | P3 | No TTL, memory not released (idle GC) |

### 1.5 Independent Bugs — Group G (Agent Loop / Tool Execution, 12 bugs)

| ID | P | Problem |
|---|---|---|
| #87 | P0 | OpenAI tool_calls argument deltas not accumulated |
| #84 | P1 | Stream retry resets fullContent, text_delta not rolled back |
| #91 | P2 | abort() leaves isRunning=true |
| #89 | P1 | AbortController listener not unbound |
| #88 | P2 | maxTurns not configured (default 25) |
| #86 | P1 | compact-first doesn't rebuild tool_calls |
| #85 | P2 | "Tool execution aborted" doesn't distinguish partial side-effect |
| #90 | P2 | provider registerTools no idempotency |
| #92 | P1 | System prompt hash stale after modification |
| #93 | P2 | tool_use_id conflict not detected |
| #95 | P2 | turnIndex off-by-one |
| #57 | P1 | MAX_MESSAGES=2000 ignores token count |

### 1.6 Independent Bugs — Group H (Memory Store, 1 bug — rest in Phase 1)

| ID | P | Problem |
|---|---|---|
| #59 | P1 | busy_timeout=3000 insufficient (already in Phase 1) |

### 1.7 Independent Bugs — Group I (Card Builder / Markdown, 7 bugs)

| ID | P | Problem |
|---|---|---|
| #13 | P1 | escapeMd misses `>!#()` |
| #73 | P1 | escapeMd same bug as #13 |
| #12 | P2 | 3000-char truncation hardcoded, not configurable |
| #30 | P1 | image/file message returns empty string |
| #31 | P2 | Post rich text only takes first paragraph |
| #32 | P3 | Mention replacement doesn't restore @name |
| #68 | P3 | i18n strings hardcoded in Chinese |

### 1.8 Independent Bugs — Group J (Profile / Identity, 13 bugs)

| ID | P | Problem |
|---|---|---|
| #25 | P0 | larkAppSecret plaintext in bots.yml, no chmod |
| #64 | P1 | writeFileSync not atomic |
| #80 | P2 | Identity file >1MB slow startup |
| #66 | P2 | mergeIdentity order unstable |
| #20 | P3 | bots.yml validation no field-level hint |
| #21 | P2 | toolProfile enum missing 'minimal' |
| #22 | P3 | allowedRoots not normalized |
| #65 | P3 | Sync IO in profile loader (downgraded P3) |
| #72 | P2 | Profile name with path separator not rejected |
| #74 | P2 | Provider creation failure silent fallback |
| #75 | P1 | enableSession=true but daemon self-manages sessions |
| #33 | P1 | card-handler action.value missing fields → crash |
| #36 | P1 | listSessions returns live reference, external mutation |

### 1.9 Independent Bugs — Misc (10 bugs)

| ID | P | Problem |
|---|---|---|
| #10 | P2 | 800ms debounce + cardPatchInFlight lost on reconnect |
| #11 | P3 | 4xx errors not distinguished, uniform retry |
| #45 | P2 | LARK_APP_ID etc. in logs not redacted |
| #49 | P3 | DEFAULT_TOKEN_LIMIT hardcoded 200k |
| #50 | P1 | enableTodo in daemon doesn't persist todos |
| #55 | P1 | enableMcp:false but settings.mcp still loads |
| #56 | P2 | Hooks not unregistered on shutdown |
| #71 | P3 | --help missing examples |
| #76 | P2 | sessionKey template string no separator disambiguation |
| #77 | P3 | RoutingContext fields too wide optional |
| #79 | P1 | Profile hot-swap doesn't rebuild runtime |
| #81 | P3 | logs command only tail, no grep support |

---

## 2. PR Execution Order

```
PR-2.1: #54 Shared Runtime Refactor (+ runtime.events)
  ↓
PR-2.2: #23 Remove currentSessionRef (depends on PR-2.1 runtime.events)
  ↓
PR-2.3: #60 Client per-appId Map (parallel with PR-2.2)
PR-2.4: Group F + G + I + J + Misc independent bugs (parallel)
```

## 3. Fix Specifications

### 3.1 PR-2.1: #54 — Shared Runtime + Lightweight Session Shells

**Problem:** `SessionManager.createSession()` calls `createAgentRuntime()` every time, creating: new Provider, new MCP connection, new SqliteMemoryStore (WAL conflict), new SkillLoader (redundant scan), new ToolRegistry with built-in tools (cross-session overwrite).

**Solution:** Split `createAgentRuntime` into daemon-level (once) and session-level (per-session):

```ts
// runtime.ts — daemon-level: called once
export async function createAgentRuntime(config: RuntimeConfig): Promise<AgentRuntime>
// Owns: provider, MCP, skillLoader, memory middleware, trace middleware, hooks

// runtime.ts — session-level: called per-session
export function createSessionAgent(
  runtime: AgentRuntime,
  contextManager: ContextManager,
  toolRegistry: ToolRegistry,
  sessionConfig: SessionConfig,
): Agent
// Reuses: provider, hooks, middlewares from runtime
// Creates: Agent instance with its own contextManager + filtered toolRegistry
```

**Key design decisions:**

**(a) Provider stops holding tools (#83 fix):**
Provider interface changes from `registerTools(tr)` → tools passed per-call: `stream(opts, tools)`. Each Agent's turn passes its own toolRegistry as parameter.

**(b) ToolRegistry view mode (#51/#53/#82 fix):**
```ts
class SubToolRegistry {
  constructor(private master: ToolRegistry, private filter: (name: string) => boolean) {}
  getAllDefinitions() { return this.master.getAllDefinitions().filter(d => this.filter(d.name)); }
  get(name: string) { return this.filter(name) ? this.master.get(name) : undefined; }
}
```
Zero copy, follows master changes automatically (skills registered on master appear in all sessions).

**(c) runtime.events event bus (#4 fix):**
```ts
// runtime.ts
runtime.events = new EventEmitter();
// Events: 'identity:reloaded' → { newPrompt: string }
//         'session:created'   → { sessionKey: string, sessionId: string }
//         'session:removed'   → { sessionKey: string, sessionId: string }
```
`UpdateIdentityTool.onReload` emits `'identity:reloaded'` instead of directly modifying agents. SessionManager listens and refreshes contextManager's system prompt for all sessions.

**(d) Middleware per-run state on RunContext.metadata:**
Phase 1 already injects `sessionId` in `context.metadata`. This PR ensures all middleware uses `context.metadata` for per-run state rather than instance fields.

**Files changed:**
| File | Change | Lines |
|---|---|---|
| `src/runtime.ts` | Split createAgentRuntime / add createSessionAgent / add runtime.events | +60 |
| `src/agent/Agent.ts` | Remove provider.registerTools from constructor | +15 |
| `src/agent/single-turn.ts` | Accept toolRegistry parameter | +8 |
| `src/providers/claude.ts` | Change registerTools → tools in stream() | +10 |
| `src/providers/openai.ts` | Same change | +10 |
| `src/tools/sub-registry.ts` | New: SubToolRegistry view class | +25 |
| `src/daemon/session-manager.ts` | Use createSessionAgent + SubToolRegistry | −30 / +15 |
| `src/daemon/daemon.ts` | update_identity onReload → runtime.events emit | +10 |
| **Total** | | **~110** |

**Cascade bugs fixed:** #51, #53, #82, #83, #26, #90, #55, #56, #74, #75

---

### 3.2 PR-2.2: #23 — Remove currentSessionRef

**Depends on:** PR-2.1 (runtime.events for session:created/removed)

**Problem:** `currentSessionRef` is a global mutable `{current: DaemonSession|null}` written by handleNewTopic/handleThreadReply and read by askUserQuestionHandler + permissionManager. Concurrent sessions overwrite each other.

**Solution:** Replace global ref with sessionId-based routing using the dual index already built in PR-2.1:

(a) **SessionManager dual index:**
```ts
class SessionManager {
  private byRoutingKey = new Map<string, DaemonSession>();  // existing
  private bySessionId  = new Map<string, DaemonSession>();  // new
  getSession(routingKey: string): DaemonSession | undefined;
  getSessionById(sessionId: string): DaemonSession | undefined;  // new
}
```
Both maps maintained in `createSession`/`removeSession`.

(b) **askUserQuestionHandler reads from context.metadata:**
```ts
// daemon.ts — handler gets sessionId from ToolContext
const askUserQuestionHandler = async (params, context) => {
  const sid = context.metadata.sessionId as string;
  const ds = sessionManager.getSessionById(sid);
  if (!ds || !bridge) throw new Error('no active session');
  return bridge.sendAskUserQuestionCard(sessionAnchorId(ds), params, ds.session.id);
};
```
Requires ToolContext to have `.metadata` (if missing, add ~5 lines). Confirmed data flow: `ContextManager.metadata` → `RunContext.metadata` → `ToolContext.metadata`.

(c) **PermissionManager per-session queue:**
```ts
class PermissionManager {
  private queues = new Map<string, PermissionRequest[]>();  // sessionId → queue
  private bridges = new Map<string, InteractiveBridge>();   // sessionId → bridge
  registerSession(sid: string, bridge: InteractiveBridge): void;
  unregisterSession(sid: string): void;
  request(sid: string, req: PermissionRequest): Promise<Decision>;
}
// Called from runtime.events 'session:created' and 'session:removed'
```
Queue capacity: per-session=10 (previously global 10). This naturally fixes #52 (subscribe overwrite).

(d) **Delete `currentSessionRef` and `bridgeRef`:**
Remove both `let` declarations in `daemon.ts`.

**Files changed:**
| File | Change | Lines |
|---|---|---|
| `src/daemon/session-manager.ts` | Dual index (bySessionId) | +15 |
| `src/daemon/daemon.ts` | Remove refs, rewrite handlers | +20 / −20 |
| `src/tools/permission-manager.ts` | Per-session queue + registerSession | +25 / −10 |
| `src/tools/ask-user-question-manager.ts` | ToolContext metadata passthrough | +5 |
| **Total** | | **~55** |

**Cascade bugs fixed:** #1, #3, #4, #52

---

### 3.3 PR-2.3: #60 — Client per-appId Map

**Independent of:** PR-2.1 and PR-2.2 (parallel)

**Problem:** Module-level `let _client, _appId, _appSecret` singleton means multi-bot daemons share one client instance, causing: ACL bypass (#5), chat cache cross-contamination (#9), wrong routing (#28), stale token on reconnect (#46).

**Solution:** Encapsulate `LarkClient` as a class, stored in a process-level Map:

```ts
class LarkClient {
  private client: Client;
  private appSecretHash: string;
  private chatModeCache = new Map<string, {mode, cachedAt}>();
  private tokenCache: {token: string, expiresAt: number} | null = null;
  private tokenInFlight: Promise<string> | null = null;

  constructor(appId: string, appSecret: string) {
    this.client = new Client({appId, appSecret, loggerLevel: ...});
    this.appSecretHash = sha256(appSecret);
  }

  // Single-flight token fetch (#26 fix)
  async getToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - 60_000) {
      return this.tokenCache.token;
    }
    if (this.tokenInFlight) return this.tokenInFlight;
    this.tokenInFlight = this._fetchToken().finally(() => { this.tokenInFlight = null; });
    return this.tokenInFlight;
  }

  async sendMessage(chatId, content, msgType): Promise<string> { ... }
  async getChatMode(chatId, opts?): Promise<'group'|'topic'|'p2p'> { ... }
  async getBotOpenId(): Promise<{openId, name}> { ... }
  invalidateChatModeCache(chatId: string): void { ... }
  close(): void { ... }
}

const clients = new Map<string, LarkClient>();

function getLarkClient(appId: string, appSecret: string): LarkClient {
  const existing = clients.get(appId);
  if (existing) {
    if (existing.appSecretHash !== sha256(appSecret)) {
      throw new Error(`[lark] appSecret mismatch for appId=${appId}`);
    }
    return existing;
  }
  const c = new LarkClient(appId, appSecret);
  clients.set(appId, c);
  return c;
}

async function closeAllLarkClients(): Promise<void> {
  for (const c of clients.values()) c.close();
  clients.clear();
}
```

**Files changed:**
| File | Change | Lines |
|---|---|---|
| `src/im/lark/client.ts` | Class encapsulation + Map factory + single-flight token | +65 / −45 |
| `src/daemon/daemon.ts` | Use `getLarkClient()` + `closeAllLarkClients()` in shutdown | +5 |
| `src/im/lark/event-dispatcher.ts` | Accept LarkClient instance instead of module functions | +10 |
| **Total** | | **~65** |

**Cascade bugs fixed:** #5, #9, #28, #46, #26, #27, #47, #67, #78 (via LarkClient encapsulation)

---

### 3.4 PR-2.4: Group F-K Independent Bug Fixes

These 75 bugs are independent of the 3 root refactors and can be fixed in parallel PRs or batched.

**Group F (Routing & Session, 17 bugs):**

| Bug | Fix | Lines |
|---|---|---|
| #2 | /close: use sessionKey(anchor, larkAppId) in removeSession | 2 |
| #37 | removeSession: call agent.abort() before delete | 3 |
| #15 | handleNewTopic: rootMessageId = thread.root_id ?? messageId | 2 |
| #16 | handleThreadReply: anchor = thread.root_id | 2 |
| #7 | event-dispatcher: LRU(event_id) dedup Set | 5 |
| #8 | event-dispatcher: strict check mentioned_bot.open_id match | 3 |
| #14 | card-handler: nullcheck session_id | 2 |
| #34 | card-handler: empty session_id → friendly error, not arbitrary | 2 |
| #17 | setupCardCallbacks: off() before on() | 2 |
| #44 | daemon.ts: mkdirSync profile.workingDir | 2 |
| #69 | session-handlers: timeout fallback to text reply | 8 |
| #6 | event-dispatcher: allow all / commands through filter | 2 |
| #29 | event-dispatcher: handle message.recalled event | 5 |
| #35 | card-handler: dedup token for button clicks | 3 |
| #38 | sessionStore: atomic rename for writes | 3 |
| #48 | card-pipeline: clear queue on session remove | 2 |
| #39 | session-manager: LRU + idle GC with TTL | 15 |

**Group G (Agent Loop / Tool Exec, 12 bugs):**

| Bug | Fix | Lines |
|---|---|---|
| #87 | single-turn.ts: accumulate OpenAI tool_call deltas[index] | 5 |
| #84 | single-turn.ts: mark retry boundary, TUI dedup | 5 |
| #91 | Agent.ts: finally reset isRunning | 1 |
| #89 | agent-loop.ts: AbortController.once + removeListener | 3 |
| #88 | agent-loop.ts: maxTurns default 25 | 2 |
| #86 | run-tools.ts: compact-first → re-call model for tool_calls | 8 |
| #85 | run-tools.ts: classify partial side-effect message | 3 |
| #90 | Agent.ts: dedup before registerTools | 3 |
| #92 | context.ts: recompute system prompt hash | 3 |
| #93 | context.ts: uniq guard for tool_use_id | 3 |
| #95 | agent-loop.ts: turnIndex start from 0 | 1 |
| #57 | context.ts: dual threshold (token priority over message count) | 5 |

**Group I (Card Builder / Markdown, 7 bugs):**

| Bug | Fix | Lines |
|---|---|---|
| #13 | card-builder.ts: complete escapeMd set (>!#()) | 3 |
| #73 | Same as #13 | — |
| #12 | card-builder.ts: maxLen from settings.cards.maxLen | 5 |
| #30 | message-parser.ts: image→"[图片]", file→"[文件:name]" | 5 |
| #31 | message-parser.ts: concatenate all post paragraphs | 3 |
| #32 | message-parser.ts: mention substitution from mentions table | 5 |
| #68 | card-handler.ts: extract string table (i18n) | 10 |

**Group J (Profile / Identity, 13 bugs):**

| Bug | Fix | Lines |
|---|---|---|
| #25 | cli-commands.ts: chmod 600 bots.yml + keychain hint | 5 |
| #64 | update-identity-tool.ts: write .tmp + rename (atomic) | 3 |
| #80 | daemon.ts: size guard >1MB fail-fast | 3 |
| #66 | profile/loader.ts: fix SOUL→IDENTITY→AGENTS order | 2 |
| #20 | profile/loader.ts: field-level validation error details | 5 |
| #21 | profile/types.ts: add 'minimal' to toolProfile enum | 1 |
| #22 | profile/types.ts: path.resolve on allowedRoots | 2 |
| #65 | profile/loader.ts: cache mtime + lazy reload (P3) | 10 |
| #72 | cli-commands.ts: reject path separator in profile name | 2 |
| #74 | runtime.ts: explicit throw on provider creation failure | 2 |
| #75 | runtime.ts: mutual exclusion check + doc | 3 |
| #33 | card-handler.ts: zod parse action.value | 5 |
| #36 | session-manager.ts: return shallow copy from listSessions | 1 |

**Misc (10 bugs):**

| Bug | Fix | Lines |
|---|---|---|
| #10 | card-pipeline.ts: force flush on reconnect | 3 |
| #11 | card-pipeline.ts: 4xx immediate fail-fast | 2 |
| #45 | daemon.ts: redact LARK_APP_SECRET from logs | 3 |
| #49 | runtime.ts: model-adaptive token limit | 5 |
| #50 | daemon.ts: inject sessionId in todo persistence | 3 |
| #55 | runtime.ts: priority fix for enableMcp vs settings.mcp | 3 |
| #56 | runtime.ts: dispose() hooks on shutdown | 5 |
| #71 | cli-commands.ts: add examples to --help | 5 |
| #76 | im/types.ts: use '\x1f' separator in sessionKey | 2 |
| #77 | im/types.ts: tighten RoutingContext optional fields | 3 |
| #79 | daemon.ts: profile watcher + rebuild runtime | 10 |
| #81 | daemon-cli.ts: pass-through args to logs | 2 |

**PR-2.4 total: ~110 lines across ~17 files.**

---

## 4. File Change Summary (All Phase 2)

| PR | Files | Lines | Bugs |
|---|---|---|---|
| 2.1 — #54 Shared Runtime | 7 | ~110 | 10 |
| 2.2 — #23 Remove currentSessionRef | 4 | ~55 | 5 |
| 2.3 — #60 Client per-appId | 3 | ~65 | 9 |
| 2.4 — Group F-K | ~17 | ~110 | 54 |
| **Total** | **~28** | **~340** | **78** |

---

## 5. Testing Strategy

### 5.1 Mock/Fixture Infrastructure (6 total; 3 from Phase 1, 3 new)

| Fixture | Phase | Purpose | Lines |
|---|---|---|---|
| `FakeProvider` | P1 | Controllable LLM stream (tool_calls fragments, 401/500) | ~80 |
| `TempProfile` | P1 | Per-test tmpdir + bots.yml + identity | ~30 |
| `TraceCapture` | P1 | Parse jsonl from traces dir | ~50 |
| `LarkWSMock` | P2 | Simulate WS connect/reconnect/event push | ~60 |
| `PermissionDriver` | P2 | Programmatic card allow/deny callback injection | ~25 |
| `SessionHarness` | P2 | One-call daemon+session+provider assembly | ~50 |

### 5.2 Test Cases (62 total; 20 from Phase 1, 42 new)

**Group A — Runtime & Session Isolation (10 cases; A01-A10)**

| TC | Bug | What It Tests | Level |
|---|---|---|---|
| A01-A07 | — | (Phase 1: see Phase 1 spec) | L1/L2 |
| A08 | #54 | createSession same sessionId idempotent (2nd call throws or returns existing) | L2 |
| A09 | #54 | create→remove→create ×100, memory growth < 5MB | L2 |
| A10 | #54 | runtime.shutdown aborts in-flight turns | L2 |
| A03 | #51, #54 | N sessions → MCP connect count = 1 | L2 |
| A04 | #82, #54 | 5 sessions × 10 writes concurrent → 0 SQLITE_BUSY | L2 |
| A05 | #83, #54 | Session A tools ≠ Session B tools, no cross-contamination | L2 |

**Group B — Permission & Session Routing (6 cases; B01-B06)**

| TC | Bug | What It Tests | Level |
|---|---|---|---|
| B01 | #23, #3 | 2 sessions concurrent permission requests → each routes to correct bridge | L2 |
| B02 | #3 | sendPermissionCard returns real user choice, not auto-deny | L2 |
| B03 | #1 | 3 sessions concurrent card streaming → no interleave | L3 |
| B04 | #4 | onReload → all 3 session prompts updated | L2 |
| B05 | #52 | 2 subscribers → both receive events | L2 |
| B06 | #23 | Session A pending → wrong sessionId callback → A still pending, B gets error | L2 |

**Group C — Trace Observability (6 cases; C01-C06)**
(Phase 1 — see Phase 1 spec)

**Group D — Self-Evolution Skills (3 cases; D01-D03)**
(Phase 1 — see Phase 1 spec)

**Group E — Lark Client (8 cases; E01-E08)**

| TC | Bug | What It Tests | Level |
|---|---|---|---|
| E01 | #60 | 2 bots in same process, events routed to correct client | L3 |
| E02 | #26 | 1000 getBotOpenId calls → token endpoint ≤ 2 calls | L2 |
| E03 | #9, #67 | getChatMode cache invalidated on chat_disbanded | L2 |
| E04 | #5, #78 | allowedUsers with email → b@x.com blocked, a@x.com allowed | L3 |
| E05 | #28 | Topic mode routing uses thread_id, not messageId | L3 |
| E06 | #46 | WS reconnect refreshes token before re-auth | L3 |
| E07 | #60 | bot1 token expired → only bot1 refetches, bot2 cache untouched | L2 |
| E08 | #60 | Same appId + different appSecret → throws secret mismatch | L1 |

**Group F — Routing & Session (7 cases; F01-F07)**

| TC | Bug | What It Tests | Level |
|---|---|---|---|
| F01 | #2 | /close → session truly removed, list confirms | L2 |
| F02 | #37 | /close during turn → agent.abort called, no zombie turn | L2 |
| F03 | #15, #16 | handleNewTopic in existing thread → rootMessageId = thread.root_id | L2 |
| F04 | #7 | Same event_id delivered 3 times → only 1 dispatch | L2 |
| F05 | #8 | @other_bot in group → dispatch skipped | L2 |
| F06 | #14, #34 | Card callback empty session_id → friendly error, no crash | L1 |
| F07 | #44 | profile.workingDir not exist → startup exit != 0, readable error | L1 |

**Group G — Agent Loop / Tool Exec (7 cases; G01-G07)**

| TC | Bug | What It Tests | Level |
|---|---|---|---|
| G01 | #87 | OpenAI stream argument deltas → complete JSON, no truncation | L2 |
| G02 | #84 | Stream retry → no duplicate text to user | L2 |
| G03 | #91 | abort() then new turn → isRunning reset | L1 |
| G04 | #89 | 100 turns → AbortController listener count stable | L1 |
| G05 | #88 | 26th turn → MaxTurnsExceeded error | L1 |
| G06 | #86 | compact-first → next turn tool_calls regenerated | L2 |
| G07 | #57 | 1000 short messages → token not over limit, no forced trim | L2 |

**Group H — Memory Store (4 cases; H01-H04)**
(Phase 1 — see Phase 1 spec)

**Group I — Card Builder / Markdown (4 cases; I01-I04)**

| TC | Bug | What It Tests | Level |
|---|---|---|---|
| I01 | #13, #73 | escapeMd covers `> ! # ( )` | L1 |
| I02 | #12 | settings.cards.maxLen=5000 → actual truncation at 5000 | L1 |
| I03 | #30 | image event → text "[图片]", file event → "[文件:name]" | L1 |
| I04 | #31 | Multi-paragraph post → all text concatenated | L1 |

**Group J — Profile / Identity (3 cases; J01-J03)**

| TC | Bug | What It Tests | Level |
|---|---|---|---|
| J01 | #25 | botSetup → bots.yml chmod 600, no plaintext secret | L1 |
| J02 | #64 | SIGKILL mid-write → file is complete or old, no half-file | L2 |
| J03 | #80 | 1MB+ identity file → startup error with size hint | L1 |

**Group K — Daemon Process (4 cases; K01-K04)**
(Phase 1 — see Phase 1 spec)

**Group L — Chaos Tests (5 cases; L03-L07)**

| TC | What It Tests | Level | Runs In |
|---|---|---|---|
| L03 | kill -9 → sessionStore + WAL all recover | L4 | nightly |
| L04 | 1000 turns → trace volume, fd count stable | L4 | nightly |
| L05 | 100 sessions × 50 turns × 5min → fd/handle no leak | L4 | nightly |
| L06 | SessionManager create/remove ×1000 → memory stable | L4 | weekly-perf |
| L07 | 100 LarkClient instances → lookup p95 < 1ms | L4 | weekly-perf |

**IMPORTANT: L05-L07 are CI-only. They MUST NOT run in pre-push hooks.**
L05 goes in `nightly` job. L06-L07 go in `weekly-perf` job (Sunday 4h).

### 5.3 CI Matrix

| Job | Trigger | Max Time | Contents | Runs L4? |
|---|---|---|---|---|
| `pr-fast` | Every PR push | < 3 min | L1 all + L2 smoke (A03, B01, E07, C01, F01, G01) | No |
| `pr-full` | merge to main | < 15 min | L1 + L2 all + L3 all (9 cases) | No |
| `nightly` | Daily 02:00 | < 60 min | L1-L3 all + L03, L04, L05 | Yes (light chaos) |
| `weekly-perf` | Sunday 02:00 | < 4 hours | All tests + L06, L07 + 2-bot long-run | Yes (full chaos) |

**Pre-push hook:** runs `pr-fast` only. Long-running tests are CI-only.

### 5.4 Bug → TC Coverage Matrix

| Bug | Primary TC | Fallback | Bug | Primary TC | Fallback |
|---|---|---|---|---|---|
| #54 | A08 | A09, A10, A03-A05 | #2 | F01 | F02 |
| #51 | A03 | — | #37 | F02 | — |
| #53 | A03 | — | #15 | F03 | — |
| #82 | A04 | — | #16 | F03 | — |
| #83 | A05 | G01 | #7 | F04 | — |
| #26 | E02 | — | #8 | F05 | — |
| #1 | B03 | — | #14 | F06 | — |
| #3 | B02 | B01, B06 | #34 | F06 | — |
| #4 | B04 | — | #17 | F01 | — |
| #52 | B05 | — | #44 | F07 | — |
| #23 | B01 | B06 | #69 | F02 | — |
| #60 | E01 | E07, E08 | #87 | G01 | — |
| #5 | E04 | — | #84 | G02 | — |
| #9 | E03 | — | #91 | G03 | — |
| #28 | E05 | — | #89 | G04 | — |
| #46 | E06 | — | #88 | G05 | — |
| #27 | E06 | — | #86 | G06 | — |
| #47 | E01 | — | #57 | G07 | — |
| #67 | E03 | — | #13 / #73 | I01 | — |
| #78 | E04 | — | #12 | I02 | — |
| #30 | I03 | — | #31 | I04 | — |
| #25 | J01 | — | #64 | J02 | — |
| #80 | J03 | — | #66 | J01 | — |
| ... | | | (All 78 bugs → matrix continues) |

## 6. Acceptance Criteria

1. `SessionManager.createSession` uses `createSessionAgent`, does NOT call `createAgentRuntime` (A08)
2. N sessions share 1 MCP connection, 1 memory store, 1 skillLoader instance (A03, A04)
3. `currentSessionRef` no longer exists in codebase
4. Permission callback routes by sessionId, not global ref (B01, B06)
5. `PermissionManager.subscribe` supports multiple subscribers (B05)
6. `getLarkClient()` factory with per-appId instances, secret mismatch throws (E01, E08)
7. `getBotOpenId` token single-flight: 1000 concurrent calls → ≤ 2 token endpoint hits (E02)
8. All 78 Phase 2 bugs have explicit TC coverage (see matrix)
9. `pr-fast` runs in < 3 min, does NOT include L4 chaos tests
10. `weekly-perf` job runs L06-L07 (4h max) in CI only, never in pre-push hook

## 7. Out of Scope

- Post-Phase-2 monitoring / alerting
- Self-evolution Phase F (prompt self-evolution)
- IM-Bridge feature additions beyond bug fixes
