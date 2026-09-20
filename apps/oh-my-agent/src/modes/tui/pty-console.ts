import { AnsiConsole, Box, Text, type TUI } from "@chengchenccc/tui";
import { ptyConsoleCommand, withPtyEnv } from "../../core/tools/bash-pty.js";

export interface PtyConsoleResult {
  exitCode: number | null;
  /** Last captured output tail (capped) for the model summary. */
  tail: string;
  killed: boolean;
}

const TAIL_CAP = 4000;

/** Run a command in a PTY inside an interactive TUI console overlay:
 *  output streams into an embedded virtual terminal, user keys are
 *  forwarded to the pty, and a lone Esc kills the session (pi's
 *  runInteractiveBashPty, transport via the `script` bridge — no native
 *  pty bindings). Resolves when the child exits or is killed. */
export function runBashPtyConsole(
  tui: TUI,
  opts: {
    command: string;
    cwd: string;
    env: Record<string, string>;
    cols?: number;
    rows?: number;
    /** Run abort / TUI close: SIGKILLs the child so the overlay promise
     *  settles and the process cannot outlive the session. */
    signal?: AbortSignal;
  },
): Promise<PtyConsoleResult> {
  const cols = Math.max(40, Math.min(opts.cols ?? tui.terminal.columns - 4, 140));
  const rows = Math.max(10, Math.min(opts.rows ?? tui.terminal.rows - 8, 40));
  const full = ptyConsoleCommand(opts.command, cols, rows) ?? opts.command;

  const proc = Bun.spawn(["bash", "-c", full], {
    cwd: opts.cwd,
    env: withPtyEnv(opts.env),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let tail = "";
  let killed = false;
  let done = false;
  // Resize forwarding: the pty is sized once via stty at spawn; on a real
  // terminal resize we push the new size INTO the child so full-screen
  // programs redraw correctly. ponytail ceiling: the pane's own geometry
  // stays at spawn size (a true re-layout means recreating the AnsiConsole
  // mid-overlay); sliceByColumn clips the residual overflow.
  const onResize = (): void => {
    if (done) return;
    proc.stdin.write(`stty rows ${tui.terminal.rows} cols ${tui.terminal.columns}\n`);
  };
  process.stdout.on("resize", onResize);
  const teardownListener = (): void => {
    process.stdout.removeListener("resize", onResize);
  };
  if (opts.signal) {
    opts.signal.addEventListener(
      "abort",
      () => {
        killed = true;
        proc.kill("SIGKILL");
      },
      { once: true },
    );
  }

  return new Promise<PtyConsoleResult>((resolve) => {
    const settle = (exitCode: number | null) => {
      if (done) return;
      done = true;
      teardownListener();
      resolve({ exitCode, tail: tail.slice(-TAIL_CAP), killed });
    };

    const pane = new AnsiConsole(
      cols,
      rows,
      (data: string) => {
        if (!done) proc.stdin.write(data);
      },
      () => {
        killed = true;
        proc.kill("SIGKILL");
      },
      () => tui.requestRender(),
    );

    const pump = (stream: ReadableStream<Uint8Array>) => {
      void (async () => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;
          const text = decoder.decode(value, { stream: true });
          tail += text;
          if (tail.length > TAIL_CAP) tail = tail.slice(-TAIL_CAP);
          pane.write(text);
        }
      })();
    };
    pump(proc.stdout);
    pump(proc.stderr);

    const overlay = new Box(1, 0);
    overlay.addChild(new Text(`  ${opts.command.slice(0, 80)} — esc kills`, 0, 0));
    overlay.addChild(pane);
    const handle = tui.showOverlay(overlay, { width: "95%", anchor: "center" });
    tui.setFocus(pane);

    void proc.exited
      .then((code) => {
        // Let the last output flush into the pane before teardown.
        setTimeout(() => {
          if (tui.isStopped) {
            // The TUI closed while the console was up: writing modes into
            // the user's restored terminal would leak escapes.
            settle(code);
            return;
          }
          tui.setFocus(null);
          handle.hide();
          // The pty child owned the terminal: re-assert raw mode + Kitty
          // keyboard flags before handing it back to the editor.
          tui.terminal.reassertTerminalState();
          tui.requestRender(true);
          settle(code);
        }, 120);
      })
      .catch(() => {
        teardownListener();
        tui.setFocus(null);
        handle.hide();
        tui.terminal.reassertTerminalState();
        settle(null);
      });
  });
}
