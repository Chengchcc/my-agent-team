"use client";

import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAgentList } from "@/features/agents/hooks";
import { useProjectList, useProjectWorktrees } from "@/features/projects/hooks";
import { type AgentRow, api, type CodingTerminalRow, type ProjectRow } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useSpawnTerminal } from "../hooks";

export interface CodingSelection {
  projectId: string;
  agentId: string;
}

/** Four-state dot (P2): the oma TUI publishes working/blocked/idle; a
 *  shell pane or a dead process falls back to the plain two-state dot. */
export function terminalDot(term: { status: string; agentState?: string }): {
  mark: string;
  cls: string;
  label: string;
} {
  if (term.status === "exited") {
    return { mark: "○", cls: "text-zinc-500", label: "exited" };
  }
  if (term.agentState === "blocked") {
    return { mark: "◉", cls: "text-amber-500", label: "blocked" };
  }
  if (term.agentState === "working") {
    return { mark: "●", cls: "animate-pulse text-emerald-500", label: "working" };
  }
  if (term.agentState === "idle") {
    return { mark: "○", cls: "text-emerald-700", label: "idle" };
  }
  return { mark: "●", cls: "text-emerald-500", label: "running" };
}
function dotFor(
  terminals: CodingTerminalRow[],
  projectId: string,
  agentId: string,
): { mark: string; cls: string; label: string } {
  const ts = terminals.filter((x) => x.projectId === projectId && x.agentId === agentId);
  if (ts.length === 0) return { mark: "○", cls: "text-zinc-600", label: "" };
  // Roll up the worktree's panes: blocked outranks working outranks a plain
  // running shell outranks idle outranks exited.
  const rank = (x: CodingTerminalRow): number => {
    if (x.agentState === "blocked") return 0;
    if (x.agentState === "working") return 1;
    if (x.status === "running" && !x.agentState) return 2;
    if (x.agentState === "idle") return 3;
    return 4;
  };
  const best = [...ts].sort((a, b) => rank(a) - rank(b))[0]!;
  return terminalDot(best);
}

function ProjectWorktreeRows({
  project,
  terminals,
  selected,
  onSelect,
}: {
  project: ProjectRow;
  terminals: CodingTerminalRow[];
  selected: CodingSelection | null;
  onSelect: (sel: CodingSelection) => void;
}) {
  const { data } = useProjectWorktrees(project.projectId);
  const worktrees = data?.worktrees ?? [];
  const spawn = useSpawnTerminal();
  const agents = useAgentList() as { data?: AgentRow[] };

  function open(agentId: string) {
    onSelect({ projectId: project.projectId, agentId });
    const has = terminals.some((x) => x.projectId === project.projectId && x.agentId === agentId);
    if (!has) {
      spawn.mutate({ projectId: project.projectId, agentId, title: "bash" });
    }
  }

  async function attachAgent(agentId: string) {
    const agent = agents.data?.find((a) => a.id === agentId);
    if (!agent) return;
    const projects = agent.projects ?? [];
    if (!projects.includes(project.projectId)) {
      try {
        await api.updateAgent(agentId, { projects: [...projects, project.projectId] });
        toast.success(t("Agent attached — worktree materializing"));
      } catch (e) {
        toast.error(t("Attach failed"), { description: String(e) });
      }
    }
  }

  if (worktrees.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-zinc-500">
        <div>{t("No worktrees — attach an agent:")}</div>
        <select
          className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-xs text-zinc-200"
          defaultValue=""
          onChange={(e) => {
            if (e.target.value) void attachAgent(e.target.value);
            e.target.value = "";
          }}
        >
          <option value="">{t("attach agent…")}</option>
          {(agents.data ?? [])
            .filter((a) => a.enabled !== false)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.id}
              </option>
            ))}
        </select>
      </div>
    );
  }

  return (
    <div>
      {worktrees.map((wt) => {
        const dot = dotFor(terminals, project.projectId, wt.agentId);
        const active = selected?.projectId === project.projectId && selected.agentId === wt.agentId;
        return (
          <button
            key={wt.agentId}
            type="button"
            onClick={() => open(wt.agentId)}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-zinc-800/60 ${
              active ? "bg-zinc-800" : ""
            }`}
          >
            <span className={dot.cls} title={dot.label}>
              {dot.mark}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-zinc-200">{wt.agentId}</span>
              <span className="block truncate text-[10px] text-zinc-500">
                {project.name} · {wt.worktreeReady ? wt.branch : "not ready"}
                {wt.ahead > 0 ? ` ↑${wt.ahead}` : ""}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function NewProjectForm() {
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim() || !repoUrl.trim()) return;
    setBusy(true);
    try {
      await api.createProject({
        name: name.trim(),
        repoUrl: repoUrl.trim(),
        defaultBranch: branch.trim() || undefined,
      });
      toast.success(t("Project created"));
      setName("");
      setRepoUrl("");
      setBranch("");
    } catch (e) {
      toast.error(t("Create failed"), { description: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1 px-3 py-2">
      <Input
        placeholder={t("name")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="h-7 text-xs"
      />
      <Input
        placeholder={t("repo URL")}
        value={repoUrl}
        onChange={(e) => setRepoUrl(e.target.value)}
        className="h-7 text-xs"
      />
      <Input
        placeholder={t("default branch (optional)")}
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        className="h-7 text-xs"
      />
      <Button
        size="sm"
        className="h-7 w-full text-xs"
        disabled={busy}
        onClick={() => void create()}
      >
        <PlusIcon className="size-3.5" />
        {t("Create project")}
      </Button>
    </div>
  );
}

/** Herdr-style two halves: spaces (projects) on top, agents (worktrees,
 *  flattened) below. Clicking a worktree row jumps straight to its pane. */
export function CodingRail({
  terminals,
  selected,
  onSelect,
}: {
  terminals: CodingTerminalRow[];
  selected: CodingSelection | null;
  onSelect: (sel: CodingSelection) => void;
}) {
  const { data } = useProjectList();
  const projects = data?.projects ?? [];
  const [showNew, setShowNew] = useState(false);

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col overflow-y-auto border-r border-zinc-800 bg-zinc-950">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          {t("Projects")}
        </span>
        <button
          type="button"
          className="text-zinc-500 hover:text-zinc-300"
          title={t("New project")}
          onClick={() => setShowNew((v) => !v)}
        >
          <PlusIcon className="size-4" />
        </button>
      </div>
      {showNew ? <NewProjectForm /> : null}
      {projects.length === 0 && !showNew ? (
        <div className="px-3 py-2 text-xs text-zinc-500">
          {t("No projects yet — create one to start coding.")}
        </div>
      ) : null}
      <div className="border-b border-zinc-800 py-1">
        {projects.map((p) => {
          const mine = terminals.filter((x) => x.projectId === p.projectId);
          const blocked = mine.some((x) => x.agentState === "blocked");
          const running = mine.some((x) => x.status === "running");
          return (
            <div key={p.projectId} className="flex items-center gap-2 px-3 py-1 text-xs">
              <span
                className={
                  blocked ? "text-amber-500" : running ? "text-emerald-500" : "text-zinc-600"
                }
              >
                {blocked ? "◉" : running ? "●" : "○"}
              </span>
              <span className="truncate font-medium text-zinc-300">{p.name}</span>
              <span className="ml-auto truncate text-[10px] text-zinc-500">
                {p.defaultBranch ?? "—"}
              </span>
            </div>
          );
        })}
      </div>

      <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
        {t("Worktrees")}
      </div>
      <div className="min-h-0 flex-1">
        {projects.map((p) => (
          <ProjectWorktreeRows
            key={p.projectId}
            project={p}
            terminals={terminals}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
      </div>
    </aside>
  );
}
