// The reported symptom: "下一轮 turn 会卡一下" + "最后一轮输出一大段 md 卡更久，然后一起输出".
// Hypothesis A: renderer cost (measured: 5-20ms/frame — NOT seconds. Not the cause).
// Hypothesis B: the TURNS don't stream at all — events arrive but paints are
//   starved. Prime suspect: the 66ms busy throttle I just added! reconcile
//   runs but returns without requesting a paint; the LOADER tick was supposed
//   to carry paints... but check: Loader.updateDisplay calls ui.requestRender
//   — every 80ms → paints at 12.5Hz. That should still stream visibly.
// Hypothesis C: view-state applyEvent creates items only on message_end (not
//   per delta) — i.e. the TUI never sees streaming text for later turns.
// Measure: does message_update actually flow per delta? Check event wiring.
