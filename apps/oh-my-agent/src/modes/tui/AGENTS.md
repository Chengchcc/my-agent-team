# AGENTS.md — oma TUI layer

The interactive surface: session loop (`tui-mode.ts`), terminal io (`tui-io.ts`),
view state (`view-state.ts`), transcript reconciliaton (`tui-transcript-reconciler.ts`),
rendering shell (`tui-render.ts`), slash commands, overlays.

Framework-level renderer/scrollback/cursor contracts live in
`packages/tui/AGENTS.md` — read that first. **`packages/tui` is consumed as
`dist`**: after editing that package, `bun run build` there before trusting any
test in this directory.

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

- Item keys are **positional**: `` `${runIndex}:${itemIndex}` ``. Any change in
  item count or order at an index triggers `reset(transcript)` + `didReset`,
  which forces a destructive frame (`requestRender(true)`).
- Therefore: **never insert/remove items mid-list while streaming**; append
  only. A status item pushed in the middle rewrites every later key and costs
  a full transcript rebuild per frame.
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
