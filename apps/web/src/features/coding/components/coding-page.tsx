"use client";

import { Columns2Icon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Page, PageBody } from "@/components/page";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { CodingTerminalRow } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useCloseTerminal, useCodingTerminalsList, useSpawnTerminal } from "../hooks";
import { CodingRail, type CodingSelection, terminalDot } from "./coding-rail";
import { SplitView } from "./split-view";
import { TerminalPane } from "./terminal-pane";

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
    ? terminals.filter((x) => x.projectId === selected.projectId && x.agentId === selected.agentId)
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

  return (
    <Page>
      {confirmDialog}
      <PageBody className="flex min-h-0 flex-1 flex-col overflow-hidden">
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
                      <span
                        key={term.terminalId}
                        className={`group flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs ${
                          term.terminalId === active?.terminalId
                            ? "bg-zinc-800 text-zinc-100"
                            : "text-zinc-400 hover:bg-zinc-800/60"
                        }`}
                        onClick={() => setActiveId(term.terminalId)}
                      >
                        <span className={dot.cls} title={dot.label}>
                          {dot.mark}
                        </span>
                        {term.title}
                        <button
                          type="button"
                          className="opacity-0 transition-opacity group-hover:opacity-100"
                          title={t("Close (kills process)")}
                          onClick={(e) => {
                            e.stopPropagation();
                            void requestClose(term);
                          }}
                        >
                          <XIcon className="size-3" />
                        </button>
                      </span>
                    );
                  })}
                  <button
                    type="button"
                    className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800/60"
                    title={t("New terminal in this worktree")}
                    onClick={() =>
                      spawn.mutate({
                        projectId: selected.projectId,
                        agentId: selected.agentId,
                        title: "bash",
                      })
                    }
                  >
                    <PlusIcon className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    className={`ml-auto rounded px-2 py-1 text-xs ${
                      split ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/60"
                    }`}
                    title={t("Toggle split view")}
                    onClick={() => setSplit((v) => !v)}
                  >
                    <Columns2Icon className="size-3.5" />
                  </button>
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
      </PageBody>
    </Page>
  );
}
