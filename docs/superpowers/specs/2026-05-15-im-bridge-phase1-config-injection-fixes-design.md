# IM-Bridge Phase 1: Config/Injection Fixes + Defense Layers

**Date:** 2026-05-15
**Status:** approved
**Scope:** 7 root-cause fixes, 25 bugs total, ~97 production lines, ~20 test cases (~240 lines)

---

## 1. Complete Bug Inventory & Phase Assignment

### 1.1 Phase 1 Bugs (25 bugs — this spec)

Root Causes (7):
| ID | P | File:Line | Problem | Fix |
|---|---|---|---|---|
| #97 | P0 | daemon.ts:75-86 | createAgentRuntime without settings → evolution=null | Pass globalSettings |
| #96 | P0 | trace/agent-middleware.ts:79 | sessionId reads metadata.sessionId, never written in daemon | Inject ds.session.id |
| #94 | P0 | skills/middleware.ts:117-122 | validateSkillPath only allows baseDir, rejects ~/.my-agent/skills/auto/ | Check all sourcePaths |
| #99 | P0 | trace/trace-buffer.ts:80-82 | .catch(()=>{}) swallows all IO errors | debugLog on error |
| #98 | P1 | trace/agent-middleware.ts:77 | shutdown doesn't await setImmediate(finalize) → summary lost | Expose flush() |
| #112 | P0 | daemon.ts:213-218 | process.exit(0) without trace/memory flush | Graceful shutdown sequence |
| #58 | P0 | runtime.ts:266 | SqliteMemoryStore('general') no profileId → cross-profile privacy leak | Inject profileId as namespace |

Direct Cascade (12):
| ID | P | File:Line | Problem | Root |
|---|---|---|---|---|
| #111 | P1 | runtime.ts:setupTrace | Silent disable, no log | #97 |
| #108 | P2 | runtime-providers.ts | createEvolutionProvider only supports openai | #97 |
| #109 | P3 | runtime-providers.ts | model defaults haiku but reads OPENAI_API_KEY | #97 |
| #110 | P2 | trace/index.ts | NudgeEngine cooldown hardcoded | #97 |
| #103 | P3 | trace/agent-middleware.ts | trace falls into unknown/ directory (phenomenon of #96) | #96 |
| #107 | P1 | trace/turn-settled-detector.ts | Daemon global singleton, cross-session count pollution | #96 |
| #102 | P1 | trace/index.ts | DEFAULT_TRACE_DIR resolved at module load | #96 |
| #100 | P2 | trace/store.ts | appendTurn mkdir+appendFile every call, no fd cache | #99 cascade |
| #101 | P3 | trace/store.ts | jsonl no fsync, kill -9 loses tail | #112 cascade |
| #59 | P1 | sqlite-store.ts | busy_timeout=3000 insufficient for multi-session | #58 |
| #61 | P1 | sqlite-store.ts | FTS5 query doesn't escape `"` | #58 |
| #62 | P2 | sqlite-store.ts | Vector dim mismatch no assert | #58 |

Independent (in Phase 1 scope, fixable alongside):
| ID | P | File:Line | Problem |
|---|---|---|---|
| #63 | P0 | sqlite-store.ts | storeEmbedding subquery may insert NULL rowid |
| #104 | P1 | trace/nudge-engine.ts:loadState | Parse failure resets state directly |
| #105 | P1 | trace/nudge-engine.ts:persist | Uses substring(lastIndexOf('/')) for path, not path.dirname |
| #106 | P2 | trace/turn-settled-detector.ts | tickTimer not unref'd |
| #40 | P1 | daemon.ts:start | No unhandledRejection listener |
| #41 | P2 | daemon.ts | SIGTERM doesn't gracefully close WS |

### 1.2 Phase 2 Bugs (78 bugs — separate spec)

Root Causes (3):
| ID | P | File:Line | Problem |
|---|---|---|---|
| #54 | P0 | session-manager.ts:78 | Every createSession calls createAgentRuntime |
| #23 | P0 | daemon.ts:60 | currentSessionRef global mutable, cross-session race |
| #60 | P0 | client.ts:4-6 | Module-level _client/_appId/_appSecret singleton |

Conditional Cascade (deferred to Phase 2, blocked by #54 or #23):
| ID | P | Problem | Blocked By |
|---|---|---|---|
| #51 | P1 | MCP repeated connect → port exhaustion | #54 |
| #53 | P1 | Skills repeated disk scan | #54 |
| #82 | P0 | SqliteMemoryStore multiple WAL open → SQLITE_BUSY | #54 |
| #83 | P0 | provider.registerTools cross-session overwrite | #54 |
| #26 | P1 | Repeated tenant_access_token pull (amplified by #54) | #54 |
| #1 | P0 | Card streaming module-level let, cross-session interleave | #23 |
| #3 | P0 | sendPermissionCard directly returns 'deny' | #23 |
| #4 | P1 | onReload only updates current agent | #23 |
| #52 | P0 | PermissionManager.subscribe overwrites previous | #23 |

Independent Bugs — Group E (#60 cascade):
| ID | P | Problem |
|---|---|---|
| #5 | P0 | allowedUsers ACL not actually enforced |
| #9 | P1 | getChatMode 5min cache no invalidation |
| #28 | P0 | topic mode routing uses messageId instead of threadId |
| #46 | P0 | WS reconnect uses expired token |
| #47 | P1 | event handler exception disconnects WS |
| #27 | P2 | http retry no jitter |
| #67 | P2 | chat disband event no cleanup |
| #70 | P2 | botSetup doesn't validate app_id regex |
| #78 | P0 | allowedUsers compares email to open_id |

Independent Bugs — Group F (Routing & Session Lifecycle):
| ID | P | Problem |
|---|---|---|
| #2 | P0 | /close removeSession missing larkAppId in key |
| #37 | P1 | removeSession doesn't abort running turn |
| #15 | P0 | handleNewTopic rootMessageId uses messageId not thread.root_id |
| #16 | P1 | handleThreadReply anchor miswired |
| #7 | P1 | No event_id dedup |
| #8 | P2 | @other_bot also triggers dispatch |
| #14 | P2 | session_id payload no nullcheck |
| #34 | P0 | session_id empty → picks arbitrary session |
| #17 | P2 | setupCardCallbacks duplicate binding |
| #44 | P1 | profile.workingDir not created, no error |
| #69 | P1 | reply card failure leaves session stuck |
| #6 | P2 | Self-message filter only allows /close |
| #29 | P2 | Message recall event not handled |
| #35 | P2 | Duplicate button click not idempotent |
| #38 | P2 | sessionStore write no fsync |
| #48 | P2 | flush queue leaks after session remove |

Independent Bugs — Group G (Agent Loop / Tool Execution):
| ID | P | Problem |
|---|---|---|
| #87 | P0 | OpenAI tool_calls argument deltas not accumulated |
| #84 | P1 | stream retry resets fullContent, yielded text_delta not rolled back |
| #91 | P2 | abort() leaves isRunning=true |
| #89 | P1 | AbortController listener not unbound |
| #88 | P2 | maxTurns not configured |
| #86 | P1 | compact-first doesn't rebuild tool_calls |
| #85 | P2 | "Tool execution aborted" doesn't distinguish partial side-effect |
| #90 | P2 | provider registerTools no idempotency |
| #92 | P1 | system prompt hash stale after modification |
| #93 | P2 | tool_use_id conflict not detected |
| #95 | P2 | turnIndex off-by-one |
| #57 | P1 | MAX_MESSAGES=2000 ignores token count |

Independent Bugs — Group I (Card Builder / Markdown):
| ID | P | Problem |
|---|---|---|
| #13 | P1 | escapeMd misses `>!#()` |
| #73 | P1 | escapeMd same bug as #13 |
| #12 | P2 | 3000-char truncation hardcoded |
| #30 | P1 | image/file message returns empty string |
| #31 | P2 | post rich text only takes first paragraph |
| #32 | P3 | mention replacement doesn't restore @name |
| #68 | P3 | i18n strings hardcoded in Chinese |

Independent Bugs — Group J (Profile / Identity):
| ID | P | Problem |
|---|---|---|
| #25 | P0 | larkAppSecret plaintext in bots.yml, no chmod |
| #64 | P1 | writeFileSync not atomic |
| #80 | P2 | identity file >1MB slow startup |
| #66 | P2 | mergeIdentity order unstable |
| #20 | P3 | bots.yml validation no field-level hint |
| #21 | P2 | toolProfile enum missing 'minimal' |
| #22 | P3 | allowedRoots not normalized |
| #65 | P3 | Sync IO in profile loader (downgraded P3) |
| #72 | P2 | profile name with path separator not rejected |
| #74 | P2 | provider creation failure silent fallback |
| #75 | P1 | enableSession=true but daemon self-manages |
| #10 | P2 | 800ms debounce + cardPatchInFlight lost on reconnect |
| #11 | P3 | 4xx errors not distinguished, uniform retry |
| #33 | P1 | card-handler action.value missing fields → crash |
| #36 | P1 | listSessions returns live reference |
| #39 | P3 | No TTL, memory not released |
| #45 | P2 | LARK_APP_ID etc. in logs not redacted |
| #49 | P3 | DEFAULT_TOKEN_LIMIT hardcoded 200k |
| #50 | P1 | enableTodo in daemon doesn't persist todos |
| #55 | P1 | enableMcp:false but settings.mcp still loads |
| #56 | P2 | hooks not unregistered on shutdown |
| #71 | P3 | --help missing examples |
| #76 | P2 | sessionKey template string no separator disambiguation |
| #77 | P3 | RoutingContext fields too wide optional |
| #79 | P1 | profile hot-swap doesn't rebuild runtime |
| #81 | P3 | logs command only tail, no grep |

### 1.3 Already Resolved / Eliminated (8 bugs)

| ID | P | Resolution |
|---|---|---|
| #51 | P1 | Merged into #54 |
| #53 | P1 | Merged into #54 |
| #82 | P0 | Merged into #54 |
| #83 | P0 | Merged into #54 |
| #103 | P3 | Merged into #96 |
| #23 | P0 | Merged #23/#24 into single #23 |
| #24 | P0 | Merged into #23 |
| #19 | — | False positive, deleted |

---

## 2. Fix Specifications (Phase 1)

### 2.1 #97 — Pass settings to createAgentRuntime

**File:** `src/daemon/daemon.ts:75-86`

**Change:** Pass `globalSettings` as a whole (not sliced):

```ts
const globalSettings = await getSettings();
const runtime: AgentRuntime = await createAgentRuntime({
  cwd: profile.workingDir,
  profileId: profile.id,
  allowedRoots: profile.allowedRoots ?? [profile.workingDir],
  enableMemory: true,
  enableSkills: true,
  enableTodo: true,
  enableSession: true,
  enableCompaction: false,
  enableMcp: false,
  askUserQuestionHandler,
  settings: globalSettings,
});
```

**Defense:** `runtime.ts:setupTrace()`: when `settings` undefined, `debugLog('[trace] settings not provided, evolution and trace disabled')`.

**Also fixes cascade:** #111 (silent disable), #108 (openai-only provider), #109 (model mismatch), #110 (hardcoded cooldown).

### 2.2 #96 — Inject sessionId into context metadata

**File:** `src/trace/agent-middleware.ts:82-83`, `src/daemon/session-manager.ts:119`

**Change:** In `SessionManager.runAgentTurn()`, before agent loop:
```ts
const contextManager = this.contextManagers.get(key);
if (contextManager) {
  contextManager.setMetadata('sessionId', ds.session.id);
}
```

Add `ContextManager.setMetadata(key: string, value: unknown): void` (~4 lines).

**Defense:** `TraceAgentMiddleware.sessionId()` logs warning on fallback to `'unknown'`.

**Also fixes cascade:** #103 (unknown directory), #107 (cross-session count pollution), #102 (lazy path resolve).

### 2.3 #94 — Expand validateSkillPath to all sourcePaths

**File:** `src/skills/middleware.ts:117-122`, `src/skills/loader.ts`

**Change:** `SkillLoader` pre-computes resolved roots:
```ts
// loader.ts constructor
this.resolvedRoots = Object.freeze(this.sourcePaths.map(p => path.resolve(p)));

getResolvedRoots(): readonly string[] { return this.resolvedRoots; }
```

```ts
// middleware.ts
function validateSkillPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return skillLoader.getResolvedRoots().some(
    dir => resolved.startsWith(dir + path.sep) || resolved === dir,
  );
}
```

### 2.4 #99 — Expose trace write errors

**File:** `src/trace/trace-buffer.ts:80-82`

```ts
// Before: .catch(() => {});
// After:
.catch((err) => { debugLog(`[trace] write failed: ${String(err)}`); });
```

### 2.5 #98 — Expose TraceAgentMiddleware flush

**File:** `src/trace/agent-middleware.ts`

Add `async flush(): Promise<void> { await this.currentBuffer?.flush(); }`.

### 2.6 #112 — Graceful daemon shutdown

**File:** `src/daemon/daemon.ts:213-218`, `src/runtime.ts`

Shutdown sequence: `wsClient.close()` → `traceMiddleware.flush()` → `runtime.shutdown()` (MCP close + memoryStore.close()) → `unlinkSync(pidFile)` → `process.exit(0)`.

`SqliteMemoryStore.close()`:
```ts
async close(): Promise<void> {
  this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  this.db.close();
}
```

### 2.7 #58 — Memory isolation by profileId

**File:** `src/runtime.ts:266`

```ts
function sanitizeNamespace(raw: string): string {
  if (raw.includes('/') || raw.includes('\\') || raw.includes('..')) {
    throw new Error(`Invalid profileId: ${raw}`);
  }
  return `profile-${raw}`;
}
const namespace = profileId ? sanitizeNamespace(profileId) : 'general';
const generalStore = new SqliteMemoryStore(namespace);
```

`setupMemory()` signature gains `profileId?: string`. Caller passes `config.profileId`.

**Also fixes cascade:** #59, #61, #62.

### 2.8 Independent Bug Fixes (in Phase 1 scope)

| Bug | Fix | Lines |
|---|---|---|
| #63 | storeEmbedding: wrap in transaction + use lastInsertRowid | ~8 |
| #104 | nudge-engine loadState: backup corrupt file as .bak before reset | ~5 |
| #105 | nudge-engine persist: use path.dirname instead of substring | ~2 |
| #106 | turn-settled-detector: timer.unref() | ~1 |
| #40 | daemon.ts: process.on('unhandledRejection', handler) | ~5 |
| #41 | daemon.ts: SIGTERM graceful close WS | ~5 |

## 3. runtimeHealthCheck()

**File:** `src/daemon/daemon.ts` (new function)

5 checks printed as a single-line banner:
1. `settings` is not undefined
2. `contextManager` is available (sessionId injection ready)
3. Trace directory exists and is writable
4. Auto skill path is in whitelist
5. Memory namespace is not `'general'` (regression gate for #58)

## 4. File Change Summary

| File | Lines | Bugs Fixed |
|---|---|---|
| `src/daemon/daemon.ts` | +42, −5 | #97, #112, #40, #41 + health check |
| `src/daemon/session-manager.ts` | +4 | #96 |
| `src/agent/context.ts` | +4 | #96 prerequisite |
| `src/runtime.ts` | +20 | #112, #58, #111 |
| `src/runtime-providers.ts` | +3 | #97 defense |
| `src/trace/agent-middleware.ts` | +8 | #98, #96 defense |
| `src/trace/trace-buffer.ts` | +2 | #99 |
| `src/trace/index.ts` | +2 | #102 |
| `src/trace/nudge-engine.ts` | +7 | #104, #105 |
| `src/trace/store.ts` | +6 | #100 |
| `src/trace/turn-settled-detector.ts` | +1 | #106 |
| `src/skills/loader.ts` | +4 | #94 |
| `src/skills/middleware.ts` | +5 | #94 |
| `src/memory/sqlite-store.ts` | +13 | #112, #63, #59, #61 |
| **Total** | **~97** | **25 bugs** |

## 5. Testing

### 5.1 Fixtures (3 new)

| Fixture | Purpose | Lines |
|---|---|---|
| `FakeProvider` | Controllable LLM stream responses | ~80 |
| `TempProfile` | Per-test tmpdir + bots.yml + identity | ~30 |
| `TraceCapture` | Parse jsonl from traces dir | ~50 |

### 5.2 Test Cases (~20)

| TC | Bugs | What It Tests | Level |
|---|---|---|---|
| A01 | #97 | daemon starts with evolution !== null | L2 |
| A02 | #97, #111 | trace.review.enabled=false → null + log | L2 |
| A06 | #58 | Profile memory isolation | L2 |
| A07 | #58, #72 | profileId path injection rejected | L1 |
| C01 | #96, #103 | Trace writes to `traces/<sessionId>/` | L2 |
| C02 | #98, #112 | SIGTERM → complete summary in jsonl | L3 |
| C03 | #99 | chmod 000 → log contains error | L2 |
| C04 | #104 | Corrupt state.json → backup + recreate | L2 |
| C05 | #105 | path.dirname used, not substring | L1 |
| C06 | #107 | 2 sessions × 5 turns independent counts | L2 |
| D01 | #94 | auto/foo/SKILL.md loads in daemon | L2 |
| D02 | #94 | Path traversal in auto/ rejected | L1 |
| D03 | #94, #97 | Full loop: trace → skill → reload | L3 |
| H01 | #63 | storeEmbedding no NULL rowid | L2 |
| H02 | #61 | FTS5 query with `"` safe | L1 |
| H03 | #62 | Embedding dim mismatch throws | L1 |
| H04 | #59 | 50 concurrent writes → 0 BUSY | L2 |
| K01 | #42 | Stale pidfile auto-clean | L2 |
| K03 | #40 | unhandledRejection logs, WS stays | L2 |
| K04 | #41, #112 | SIGTERM graceful: WS close + flush | L3 |

### 5.3 Bug → Test Coverage Matrix

| Bug | Primary TC | Fallback TC | Bug | Primary TC | Fallback TC |
|---|---|---|---|---|---|
| #97 | A01 | A02, D03 | #104 | C04 | — |
| #96 | C01 | C06 | #105 | C05 | — |
| #94 | D01 | D02, D03 | #106 | C06 | — |
| #99 | C03 | — | #107 | C06 | — |
| #98 | C02 | K04 | #108 | A01 | — |
| #112 | K04 | C02 | #109 | A01 | — |
| #58 | A06 | A07 | #110 | A02 | — |
| #111 | A02 | — | #40 | K03 | — |
| #100 | C06 | — | #41 | K04 | — |
| #101 | C06 | — | #42 | K01 | — |
| #102 | C01 | — | #59 | H04 | — |
| #103 | C01 | — | #61 | H02 | — |
| #63 | H01 | — | #62 | H03 | — |

## 6. Acceptance Criteria

1. `startDaemon(profileId)` → `evolution !== null` when trace.review enabled (A01)
2. Trace data lands in `traces/<sessionId>/` with ULID session id (C01)
3. Skills from `~/.my-agent/skills/auto/` load in daemon mode (D01)
4. `SIGTERM` produces complete trace summary in jsonl (C02)
5. Profile P1 memory not retrievable from profile P2 (A06)
6. `runtimeHealthCheck()` prints 5-item banner at startup
7. Trace IO errors appear in debugLog, not swallowed (C03)
8. All 25 Phase 1 bugs have explicit TC coverage (see matrix)

## 7. Out of Scope (Phase 2)

- SessionManager shared runtime refactor (#54 + cascade)
- currentSessionRef removal (#23 + cascade)
- Lark client per-appId Map (#60 + cascade)
- Group F, G, I, J independent bugs
- CI matrix configuration
- Chaos testing (L01-L07)
