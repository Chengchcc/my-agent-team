"use client";

import { Columns2Icon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CodingTerminalRow } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useCloseTerminal, useCodingTerminalsList, useSpawnTerminal } from "../hooks";
import { CodingRail, type CodingSelection, terminalDot } from "./coding-rail";
import { SplitView } from "./split-view";
import { TerminalPane } from "./terminal-pane";

/** Task-worktree cwd shape: <...>/projects/<projectId>.<slug> — the main
 *  worktree's last segment is exactly the projectId, no dot suffix. */
function isTaskWorktreeCwd(cwd: string): boolean {
  const seg = cwd.split("/").pop() ?? "";
  return /^[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9-]{0,39}$/i.test(seg);
}

export function CodingPage() {
  const terminals = useCodingTerminalsList();
  const [selected, setSelected] = useState<CodingSelection | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [split, setSplit] = useState(() =>
    typeof window === "undefined" ? false : window.localStorage.getItem("coding-split") === "1",
  );
  useEffect(() => {
    try {
      window.localStorage.setItem("coding-split", split ? "1" : "0");
    } catch {
      /* private mode — preference just doesn't persist */
    }
  }, [split]);
  const [tabHint, setTabHint] = useState<string | null>(null); // ?t= restore
  const spawn = useSpawnTerminal();
  const closeTerminal = useCloseTerminal();
  const { confirm, dialog: confirmDialog } = useConfirm();

  // ?t=<terminalId> deep-link: land back on the pane you left.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hint = params.get("t");
    if (hint) setTabHint(hint);
  }, []);

  const selTerminals = selected
    ? terminals.filter(
        (x) =>
          x.projectId === selected.projectId &&
          x.agentId === selected.agentId &&
          // A task-worktree selection groups ONLY that path's terminals;
          // a main selection groups the terminals whose cwd isn't a task
          // path (they never set worktreePath at spawn).
          (selected.worktreePath === undefined
            ? !isTaskWorktreeCwd(x.cwd)
            : x.cwd === selected.worktreePath),
      )
    : [];
  const active =
    selTerminals.find((x) => x.terminalId === activeId) ??
    selTerminals.find((x) => x.terminalId === tabHint) ??
    selTerminals[0] ??
    null;
  useEffect(() => {
    if (active) setActiveId(active.terminalId);
  }, [active]);

  // Keep the URL in sync so a refresh lands back on the same pane.
  useEffect(() => {
    const url = active ? `/coding?t=${active.terminalId}` : "/coding";
    window.history.replaceState(null, "", url);
  }, [active]);

  async function requestClose(term: CodingTerminalRow) {
    const dead = term.status === "exited";
    if (
      dead ||
      (await confirm({
        title: t("Close terminal?"),
        description: t("This kills the running process. Its oma history stays on disk."),
      }))
    ) {
      closeTerminal.mutate(term.terminalId);
    }
  }

  // Viewport-fixed layout: AppShell's <main> is a flex column with a real
  // height — the document-flow Page/PageBody pair would let the terminal
  // grow the whole page instead of scrolling inside xterm.
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {confirmDialog}
      <div className="flex min-h-0 flex-1">
        <CodingRail
          terminals={terminals}
          selected={selected}
          onSelect={(sel) => {
            setSelected(sel);
            setActiveId(null);
            setTabHint(null);
          }}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selected ? (
            <>
              <div className="flex items-center gap-1 border-b border-zinc-800 bg-zinc-950 px-2 py-1">
                {selTerminals.map((term) => {
                  const dot = terminalDot(term);
                  return (
                    <div key={term.terminalId} className="group flex items-center">
                      <Button
                        variant="ghost"
                        onClick={() => setActiveId(term.terminalId)}
                        className={`h-auto gap-1.5 rounded px-2 py-1 text-xs font-normal ${
                          term.terminalId === active?.terminalId
                            ? "bg-zinc-800 text-zinc-100"
                            : "text-zinc-400 hover:bg-zinc-800/60"
                        }`}
                      >
                        <span className={dot.cls} title={dot.label}>
                          {dot.mark}
                        </span>
                        {term.title}
                      </Button>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-5 opacity-0 transition-opacity group-hover:opacity-100"
                              onClick={() => void requestClose(term)}
                            />
                          }
                        />
                        <TooltipContent>{t("Close (kills process)")}</TooltipContent>
                      </Tooltip>
                    </div>
                  );
                })}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        onClick={() =>
                          spawn.mutate({
                            projectId: selected.projectId,
                            agentId: selected.agentId,
                            title: "bash",
                          })
                        }
                      >
                        <PlusIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipContent>{t("New terminal in this worktree")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        className={`ml-auto size-6 ${split ? "bg-zinc-800 text-zinc-100" : ""}`}
                        onClick={() => setSplit((v) => !v)}
                      >
                        <Columns2Icon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipContent>{t("Toggle split view")}</TooltipContent>
                </Tooltip>
              </div>
              <div className="min-h-0 flex-1">
                {split ? (
                  <SplitView
                    terminals={selTerminals}
                    onClosed={(id) => {
                      const term = selTerminals.find((x) => x.terminalId === id);
                      if (term) void requestClose(term);
                    }}
                  />
                ) : active ? (
                  <TerminalPane
                    key={active.terminalId}
                    terminal={active}
                    onClosed={(id) => {
                      const term = selTerminals.find((x) => x.terminalId === id);
                      if (term) void requestClose(term);
                    }}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-zinc-500">
                    {t("Opening terminal…")}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-zinc-500">
              <div>{t("Pick a worktree on the left to open its terminal.")}</div>
              <div className="text-xs text-zinc-600">
                {t("Terminals keep running when you leave this page — detach, not close.")}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
