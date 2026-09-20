# AGENTS.md — oma TUI layer

The interactive surface: session loop (`tui-mode.ts`), terminal io (`tui-io.ts`),
view state (`view-state.ts`), transcript reconciliaton (`tui-transcript-reconciler.ts`),
rendering shell (`tui-render.ts`), slash commands, overlays.

Framework-level renderer/scrollback/cursor contracts live in
`packages/tui/AGENTS.md` — read that first. **`packages/tui` is consumed as
`dist`**: after editing that package, `bun run build` there before trusting any
test in this directory.


## Component layering (ADR 0028)

Live state renders as **chrome** (pinned above the editor, repainted every
frame, never committed to scrollback); results land in the **transcript**
(append-only, durable, survives resume replay). Decision tree and rationale:
`docs/adr/0028-tui-component-layering.md`.

- todo snapshot, live subagent activity (`state.liveAgents`, fed by
  `delegation_agent_started/event/completed`) → chrome. The task tool box
  renders **empty while streaming**; the settled result tree + `✔/✘`
  terminal markers stay in the transcript.
- chrome has a repaint driver: a 100ms interval calls `requestRender` while
  busy (`tui-io.ts`, `CHROME_REPAINT_MS`). The transcript must NEVER get a
  fixed-cadence repaint driver — committed rows are immutable and a timer
  there risks scrollback corruption. Chrome lines may shimmer freely.

## The bottom slot (HITL panels)

The frame provider composes the bottom region from a **resolver**
(`createOmaFrameProvider({ bottom })`), not a fixed editor: `tui-io.ts` hands
it `docked?.panel ?? editor` and `dock()`/`undock()` swap the slot. A HITL
surface is therefore DOCKED in the editor's place — full width, growing
upward, owning the keyboard — instead of floating over the transcript. This
is the fix for a real defect: a floating box reads as one more transient
picker and covers the input row the user was about to type in.

- `ask_question` → `ask-panel.ts` (`AskPanel`). It is the only docked panel
  today; `packages/tui` has no editor-slot concept, so the swap is a provider
  concern.
- The panel follows oh-my-pi's ask dialog: recommended option focused at spawn,
  Tab/←/→ wrap, `n` notes a row (`✎ note`) and rides that row's answer,
  `option.preview` renders as markdown under its option, Submit review for
  anything that cannot finish on one keypress. `Chat about this` is NOT
  offered — it exists only on oh-my-pi's collab guest path.
- The inactivity timeout is `askTimeoutMs` (`.oma/settings.json`, env
  `OMA_ASK_TIMEOUT_MS`, omp `ask.timeout` — which is in SECONDS, this one is
  ms; 0/absent = off, oh-my-pi's default). On expiry the UNANSWERED questions
  take their recommended option and the answer carries `timedOut`, so the
  model can tell an auto-selection from consent. The countdown restarts on
  every key and is deferred while a field is open (a half-typed answer is
  never yanked). Config is resolved by the session and passed through the
  `askQuestions(input, { timeoutMs })` seam — the io implements the surface,
  it does not own the knob.
- A docked panel sizes itself from the viewport rows the provider injects
  (`setViewportRows`, duck-typed in `tui-frame-provider.ts`). Never read
  `process.stdout.rows`: the provider's `rows` is what the VirtualTerminal
  tests drive, and the panel's height must be deterministic in tests.
- The panel's height is measured once per `width:rows` and clamped to 70% of
  it; tab switches, cursor moves and typing never resize it (content scrolls
  instead), so the box does not jump under the user's cursor.
- Body lines are truncated to the inner width before they reach
  `renderOutputBlock`: the frame WRAPS what it is given, and a wrapped line
  would desynchronise the body's line-window (cursor-follow, scroll offset
  and height all count lines, 1 rendered line = 1 body row).
- The transcript side of a settled ask is `renderAskTool`
  (`tui-tool-render.ts`), which replaces the raw `{"answers":…}` JSON with the
  question/option/answer record.
- **Key ownership.** The io's global listener intercepts Esc (abort a live
  run) and ctrl+c before the focused component sees them. A dock is the
  surface the user is looking at, so both rules bend for it: the listener
  yields Esc when `docked !== null` (Esc = cancel the question, not abort the
  run), and the abort path calls `docked.dismiss()` — without the second rule
  an aborted run leaves the panel docked, focused and swallowing every
  keystroke with nothing behind it. Both are pinned by e2e tests; deleting
  either guard turns them red.

## Data flow

```
runtime event → applyEvent(state) → io.render(state)
  → TuiRenderShell.render → reconciler (transcript children) → tui.requestRender
  → provider frame paint (createOmaFrameProvider → OmaTranscriptContainer)
```

One event per streamed delta, and the runtime **awaits** the handler — so
anything synchronous here is on the model-stream critical path.

## Render coalescing (do not remove)

`TuiRenderShell.render` coalesces while a run is live:

- Per-event renders only record `latestState`; the expensive reconcile+paint
  runs at most once per `RENDER_COALESCE_MS` (50ms).
- The window is measured from the **completion** of the previous render, not
  its start. A single render can cost 100ms+ on a long markdown tail; a
  start-stamped window is already expired by the next delta and coalesces
  nothing (measured: 57/134 deltas vs 127/134 after the change).
- Settle and quit **flush** the pending render (`flushPendingRender` via
  `setBusy(false)`), so the final state always lands.
- Measured effect on a 120-delta markdown stream: render work 4453ms → 221ms,
  last line on screen 6.0s → 1.8s. Without coalescing, a long answer reads as
  "frozen, then dumped all at once" — that is this bug, not a slow model.

## Reconciler

- Item keys are **positional**: `` `${runIndex}:${itemIndex}` ``. `didReset`
  compares the current key list against `lastKeys` — the FULL snapshot of the
  previous reconcile, including items that rendered empty. Removal or reorder
  (prefix mismatch) triggers `reset(transcript)` + a destructive frame
  (`requestRender(true)`); pure suffix appends and items born transparent
  (empty assistant placeholder) never reset.
- Do NOT derive the comparison list from render-time group pushes: an item
  that renders zero rows on first sight never enters `orderKeys`, and the
  drift detonates a full clear + scrollback purge on the next reconcile
  (this is the steer-flicker bug, pinned by tui-e2e.test.ts "steer submit
  and drain paint no destructive frame").
- A destructive frame clears the screen but purges scrollback (`\x1b[3J`)
  **only when the width changed** — a rewrap is the only thing that
  misaligns committed rows above the viewport.
- Insertion mid-list self-heals WITHOUT a reset: positional keys recycle
  (`1:0` goes to the newcomer), `updateGroup` swaps the recycled slot's rows
  in place, and the shifted item appends fresh — final order is correct.
- `itemLineCache` skips caching while `item.streaming` — a streaming item
  re-renders every frame by design (see the markdown cost note in the package
  doc). Cache validity covers thinking/tool-detail/width, **not text**, so
  non-streaming items must be treated as immutable.

## View state

- `message_update` appends to the **last** assistant item of the current run;
  `message_start` opens/reuses one; `message_end`/`turn_end` settle all items
  (`streaming = false`).
- Items are settled, not removed: the transcript keeps history and only the
  viewport tail is repainted.

## Testing conventions

- e2e uses the real session loop over a `VirtualTerminal` with the fake
  provider; drive input with `typeAndSubmit`, poll the screen (never fixed
  sleeps) for anything async.
- Fake-provider knobs are env vars (`OMA_FAKE_TEXT_LINES`,
  `OMA_FAKE_THINKING_LINES`, `OMA_FAKE_TOOL`, `OMA_*_DELAY_MS`) — **always
  restore them in `finally`**, and set `OMA_TITLE_ENABLED=0` /
  `OMA_MEMORY_EXTRACT=0` when the test measures post-run timing, since both
  make extra model calls.
- Timing assertions belong on **arrival latency** (when did the tail land),
  not on frame counts; frame counts depend on coalescing and make flaky tests.
- When a log-based diagnosis spans several tests, run the single test with
  `-t` before drawing conclusions — mixing stderr from sibling tests produced
  a completely wrong "providerWindow keeps resetting" theory once.
