# AGENTS.md — packages/tui

Working contract for the terminal UI framework. Read this **before** touching
the renderer: the invariants below are not visible from any single file, and
violating one produces symptoms that look like something else entirely
(flicker, stalls, corrupted scrollback, cursor jumping).

## The trap that costs the most time: this package is consumed as `dist`

```
packages/tui/package.json → exports: { ".": "./dist/index.js" }
```

- Tests **inside** this package run against `src/` (bun resolves the files directly).
- Every **consumer** — `apps/oh-my-agent` (TUI + e2e tests), the product build —
  imports `dist/`.

So editing `src/tui.ts` changes nothing for any integration test or app run
until you `bun run build` here. Symptom of forgetting: you "fix" the painter,
rerun the app e2e, and the behaviour is byte-identical. If an app-level test
ignores your change, rebuild this package first, then debug.

## Two painters, one per configuration

| Path | When | Renders |
|---|---|---|
| **Provider frame** (`renderProviderFrame`) | a frame provider is installed (`setFrameProvider`) — **this is what oma uses** | `provider.renderFrame({columns, rows})` → viewport + optional history batch, painted over native scrollback |
| **Differential renderer** (`fullRender` / line diff) | no frame provider | component tree vs `previousLines` |

Invariants for the provider path:

1. The provider **must** return at most `rows` rows. More is a contract
   violation (omp throws in test/dev; here it is truncated) and indicates the
   provider is not slicing its transcript to the available height.
2. `providerWindow` holds the previous frame's rows; `renderProviderFrame`
   diffs against it. The diff is **only sound when geometry is stable**
   (same width/height, no destructive reset) **and no history was appended**
   this frame — an appended batch scrolls the screen, which shifts every row's
   position. A "shift detection" that tries to generalize the diff across
   scroll frames **corrupted scrollback** (history rows landed in viewport
   slots); it was implemented and reverted. Keep the conservative gate.
3. `history` batches are append-only and **must be acknowledged**
   (`acknowledgeHistory`) once written; the provider advances its committed
   frontier on ack. Unacknowledged batches are re-offered.
4. Destructive resets (`clearScrollbackOnNextRender` / a width change) clear
   `providerWindow` — one full rewrite is expected there, and only there.
   `requestRender(true)` sets sentinel values (`previousWidth = -1`, …), so the
   very next provider frame is destructive by design.

## Render scheduling and backpressure

- `MIN_RENDER_INTERVAL_MS` (16ms) is the cadence **floor**.
- **Adaptive backpressure**: the next ordinary frame starts no sooner than
  `last_frame_start + 2 × last_frame_cost` (targets ~50% duty cycle), capped at
  `MAX_ADAPTIVE_RENDER_MS` (200ms). This exists so a heavy frame (long markdown
  tail) cannot saturate the loop and starve input/loader paints. Frame cost is
  measured around `doRender()` on both the scheduled and the forced path — if
  you add a render path, record its cost too or the backpressure silently
  stops seeing it.
- Forced renders bypass the cadence. `renderNow()` is the synchronous forced
  paint used at startup.

## Cursor and flicker

- The editor emits a `CURSOR_MARKER`; `extractCursorPosition` strips it and
  returns the visual position, which the frame writer applies **absolutely at
  the end of the buffer**.
- Frames are wrapped in `\x1b[?2026h`/`l` (synchronized output). **Terminals
  that ignore it — tmux 3.3a does — show the write sequence itself.** A painter
  that blanks (`\x1b[2K`) and rewrites every row therefore reads as constant
  transcript flicker on every spinner tick, and the cursor appears to sweep
  through the transcript. This is why the provider path diffs at all: a
  spinner-only frame must emit ~one row.
- Row writes use absolute addressing for dirty runs; do not "optimize" that
  back into sequential `\r\n` writes without re-checking the diff conditions.

## Scrollback semantics

- Committed rows go to the terminal's native scrollback. The viewport is
  bounded and bottom-anchored above the status/editor block.
- `beginHistoryReplay()` resets the frontier (resize / destructive reset);
  the provider must re-offer its history after a replay.
- When the viewport shrinks, rows released upward become scrollback — never
  write blanks over committed rows to "clean up".

## Markdown streaming cache (`components/markdown.ts`)

- The stream prefix freeze only happens at `\n\n` boundaries (an open fenced
  code block also blocks it). Documents **without blank lines** — tight
  paragraphs, long lists — never freeze, so each frame re-lexes and re-wraps
  the whole text: measured ~31ms average / ~89ms worst for a 120-line answer
  (~3.8s of render work over one stream). With blank lines the same document
  costs ~1.6ms average.
- Consequence for consumers: per-delta renders of a growing markdown tail are
  **O(n) and expensive**; coalesce at the app layer (oma's `TuiRenderShell`
  does) rather than assuming the markdown component is cheap.
- `setText()` invalidates caches; `render(width)` caches on (text, width).
  Non-append edits drop the streaming prefix (correct — the tail is no longer
  a suffix of the new text).

## Testing conventions

- `VirtualTerminal` (test seam, also exported as `./testing`) drives a real
  xterm headless; assert on `getViewport()`, or capture `vt.write` to inspect
  the **raw escape stream** when the symptom is about what was *written*
  (flicker, diffing) rather than what ended up on screen.
- Timers live in the render path: poll (`waitForText`-style) instead of fixed
  sleeps for anything async, and drive frames with `requestRender()` in unit
  tests.
- Debug instrumentation must be **tagged and isolated**: a `tail` of mixed
  stderr from several tests in one file reads as one coherent (wrong) story.
  Run the single failing test with `-t` before believing a log pattern.
