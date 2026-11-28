"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { RotateCwIcon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EntityLink } from "@/components/ui/entity-link";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, type CodingHarness, type CodingTerminalRow } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLaunchHarness, useRespawnTerminal } from "../hooks";
import { CODING_HARNESS_OPTIONS } from "../locate";

type PaneConnection = "connecting" | "live" | "dropped";

/** The pane's status word and colour: harness state while it is an interactive harness pane,
 *  then whether its process is alive, then the socket. Presentation only. */
function paneStatus(
  terminal: { kind: string; agentState?: string; exitCode: number | null },
  exited: boolean,
  conn: PaneConnection,
): { cls: string; text: string } {
  const state = terminal.agentState;
  const harnessLabel = terminal.kind === "shell" ? "agent" : terminal.kind;
  if (typeof state === "string" && state !== "") {
    if (state === "working") {
      return { cls: "animate-pulse text-(--primary)", text: `${harnessLabel} ${t(state)}` };
    }
    if (state === "idle") {
      return { cls: "text-(--primary-deep)", text: `${harnessLabel} ${t(state)}` };
    }
    return { cls: "text-(--warn)", text: `${harnessLabel} ${t(state)}` };
  }
  if (exited) {
    return {
      cls: "text-(--mute)",
      text: t("process exited ({code})", { code: terminal.exitCode ?? 0 }),
    };
  }
  if (conn === "live") return { cls: "text-(--primary)", text: t("live") };
  const waiting = conn === "connecting" ? t("connecting…") : t("reconnecting…");
  return { cls: "text-(--warn)", text: waiting };
}

/** One PTY pane: xterm.js ↔ one-time-ticket WebSocket ↔ backend registry.
 *  Closing this component (or the tab, or the browser) is a DETACH — the
 *  process keeps running in the backend and the buffer replays on return.
 *  The ✕ button is the only CLOSE (kill) path and lives one level up. */
export function TerminalPane({
  terminal,
  defaultHarness = "oma",
  onClosed,
}: {
  terminal: CodingTerminalRow;
  defaultHarness?: CodingHarness;
  onClosed: (id: string) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [conn, setConn] = useState<"connecting" | "live" | "dropped">("connecting");
  const [exitedCode, setExitedCode] = useState<number | null>(
    terminal.status === "exited" ? terminal.exitCode : null,
  );
  const [closing, setClosing] = useState<"idle" | "closing">("idle");
  const [selectedHarness, setSelectedHarness] = useState<CodingHarness>(defaultHarness);
  const launchHarness = useLaunchHarness();
  const respawnTerminal = useRespawnTerminal();

  useEffect(() => {
    setSelectedHarness(defaultHarness);
  }, [defaultHarness]);

  const exited = exitedCode !== null;
  const status = paneStatus(terminal, exited, conn);
  const activeRunCount = terminal.activeRuns?.length ?? 0;
  const waitingRun = terminal.activeRuns?.some(
    (run) => run.status === "waiting" || run.pendingActionCount > 0,
  );

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
    // fit() against an unconstrained container feeds itself (rows →
    // height → more rows); only fit when the layout gave us real pixels.
    const safeFit = () => {
      if (el.clientHeight < 50) return;
      try {
        fit.fit();
      } catch {
        /* not laid out yet — the ResizeObserver below picks it up */
      }
    };
    safeFit();
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
      safeFit();
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
    setClosing("closing");
    try {
      onClosed(terminal.terminalId);
    } finally {
      setClosing("idle");
    }
  }

  function startSelectedHarness(harness: CodingHarness) {
    toast.promise(launchHarness.mutateAsync({ id: terminal.terminalId, harness }), {
      loading: t("Starting {harness}…", { harness }),
      success: t("{harness} launched", { harness }),
      error: (e) => String(e),
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0d1117]">
      <div className="flex flex-wrap items-center gap-2 border-b border-(--hairline) px-3 py-1.5 text-xs text-(--mute)">
        <span className="font-mono text-(--body)">
          {terminal.title} · {terminal.cwd.split("/").pop()}
        </span>
        <span className={status.cls}>{status.text}</span>
        {activeRunCount > 0 && (
          <span
            className={
              waitingRun
                ? "rounded-full border border-(--warn)/40 bg-(--warn)/10 px-2 py-0.5 text-[10px] font-medium text-(--warn)"
                : "rounded-full border border-(--primary)/40 bg-(--primary)/10 px-2 py-0.5 text-[10px] font-medium text-(--primary)"
            }
          >
            {waitingRun ? t("Approval needed") : t("Worker active")}
          </span>
        )}
        {terminal.requirementId && (
          <EntityLink
            kind="requirement"
            id={terminal.requirementId}
            label={terminal.labels?.requirementTitle}
            href={`/requirements/${encodeURIComponent(terminal.requirementId)}`}
            variant="pill"
          />
        )}
        {terminal.conversationId && (
          <EntityLink
            kind="conversation"
            id={terminal.conversationId}
            label={terminal.labels?.conversationTitle}
            href={`/chat/${encodeURIComponent(terminal.conversationId)}`}
            variant="pill"
          />
        )}
        <div className="ml-auto flex items-center gap-1">
          <Select
            items={CODING_HARNESS_OPTIONS.map((h) => ({ value: h, label: h }))}
            value={selectedHarness}
            onValueChange={(value) => {
              if (value) setSelectedHarness(value as CodingHarness);
            }}
          >
            <SelectTrigger
              className="h-7 w-22 border-(--hairline) bg-transparent px-2 text-xs text-(--body)"
              aria-label={t("Select CLI harness")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CODING_HARNESS_OPTIONS.map((h) => (
                <SelectItem key={h} value={h}>
                  {h}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={exited || launchHarness.isPending}
            title={t("Start {harness} in this pane", { harness: selectedHarness })}
            onClick={() => startSelectedHarness(selectedHarness)}
          >
            <SparklesIcon className="size-3.5" />
            <span className="ml-1">{t("Launch")}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={respawnTerminal.isPending}
            title={t("Restart the process in this pane")}
            onClick={() =>
              toast.promise(respawnTerminal.mutateAsync(terminal.terminalId), {
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
            className="h-7 px-2 text-xs text-(--err) hover:text-(--err)/80"
            disabled={closing === "closing"}
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
