"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { RotateCwIcon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, type CodingTerminalRow } from "@/lib/api";
import { t } from "@/lib/i18n";

/** One PTY pane: xterm.js ↔ one-time-ticket WebSocket ↔ backend registry.
 *  Closing this component (or the tab, or the browser) is a DETACH — the
 *  process keeps running in the backend and the buffer replays on return.
 *  The ✕ button is the only CLOSE (kill) path and lives one level up. */
export function TerminalPane({
  terminal,
  onClosed,
}: {
  terminal: CodingTerminalRow;
  onClosed: (id: string) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [conn, setConn] = useState<"connecting" | "live" | "dropped">("connecting");
  const [exitedCode, setExitedCode] = useState<number | null>(
    terminal.status === "exited" ? terminal.exitCode : null,
  );
  const [closing, setClosing] = useState(false);

  const exited = exitedCode !== null;

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const term = new Terminal({
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false,
      theme: { background: "#0d1117" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      fit.fit();
    } catch {
      /* not laid out yet — the ResizeObserver below picks it up */
    }

    let disposed = false;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const sendResize = () => {
      const dims = fit.proposeDimensions();
      if (ws?.readyState === WebSocket.OPEN && dims && dims.cols > 1 && dims.rows > 1) {
        ws.send(JSON.stringify({ t: "r", cols: dims.cols, rows: dims.rows }));
      }
    };

    const connect = async () => {
      if (disposed) return;
      setConn("connecting");
      try {
        const { ticket, wsBase } = await api.codingWsTicket();
        if (disposed) return;
        ws = new WebSocket(
          `${wsBase}/ws/coding/${terminal.terminalId}?ticket=${encodeURIComponent(ticket)}`,
        );
        ws.addEventListener("message", (ev) => {
          try {
            const msg = JSON.parse(String(ev.data)) as {
              t: string;
              d?: string;
              status?: string;
              exitCode?: number | null;
            };
            if (msg.t === "o" && msg.d) term.write(msg.d);
            else if (msg.t === "s") {
              setExitedCode(msg.status === "exited" ? (msg.exitCode ?? 0) : null);
            }
          } catch {
            /* ignore malformed frames */
          }
        });
        ws.addEventListener("open", () => {
          if (disposed) return;
          setConn("live");
          sendResize();
        });
        ws.addEventListener("close", () => {
          if (disposed) return;
          setConn("dropped");
          // detach ≠ stop: reconnect with a fresh ticket; the pane and its
          // scrollback live in the backend meanwhile.
          retryTimer = setTimeout(() => void connect(), 1500);
        });
      } catch {
        if (!disposed) retryTimer = setTimeout(() => void connect(), 2000);
      }
    };

    term.onData((d) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "i", d }));
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* container hidden */
      }
      sendResize();
    });
    ro.observe(el);

    void connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
      ro.disconnect();
      term.dispose();
    };
  }, [terminal.terminalId]);

  async function close() {
    setClosing(true);
    try {
      onClosed(terminal.terminalId);
    } finally {
      setClosing(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0d1117]">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-xs text-zinc-400">
        <span className="font-mono">
          {terminal.title} · {terminal.cwd.split("/").pop()}
        </span>
        <span
          className={
            exited ? "text-zinc-500" : conn === "live" ? "text-emerald-500" : "text-amber-500"
          }
        >
          {exited
            ? `process exited (${terminal.exitCode ?? 0})`
            : conn === "live"
              ? "live"
              : conn === "connecting"
                ? "connecting…"
                : "reconnecting…"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={exited}
            title={t("Start oma in this pane")}
            onClick={() =>
              toast.promise(api.launchOmaInTerminal(terminal.terminalId), {
                loading: t("Starting oma…"),
                success: t("oma launched"),
                error: (e) => String(e),
              })
            }
          >
            <SparklesIcon className="size-3.5" />
            <span className="ml-1">oma</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            title={t("Restart the process in this pane")}
            onClick={() =>
              toast.promise(api.respawnCodingTerminal(terminal.terminalId), {
                loading: t("Restarting…"),
                success: t("Pane restarted"),
                error: (e) => String(e),
              })
            }
          >
            <RotateCwIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-red-400 hover:text-red-300"
            disabled={closing}
            title={t("Close terminal (kills the process)")}
            onClick={() => void close()}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>
      <div ref={holder} className="min-h-0 flex-1 p-2" />
    </div>
  );
}
