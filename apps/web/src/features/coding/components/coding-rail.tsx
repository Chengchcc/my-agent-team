"use client";

import { CornerUpLeftIcon, FileDiffIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ProjectForm } from "@/components/ProjectForm";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAgentList } from "@/features/agents/hooks";
import { useProjectList, useProjectWorktrees } from "@/features/projects/hooks";
import { api, type CodingTerminalRow, type ProjectRow } from "@/lib/api";
import { t } from "@/lib/i18n";
import {
  useCreateTaskWorktree,
  usePromoteTaskWorktree,
  useRemoveTaskWorktree,
  useSpawnTerminal,
  useTaskWorktrees,
} from "../hooks";
import { isTaskWorktreeCwd } from "../locate";

export interface CodingSelection {
  /** ADR 0073: absent = the agent's OWN workspace (no project worktree). */
  projectId?: string;
  agentId: string;
  /** Task-worktree path (clicking a slug row) — undefined = main worktree. */
  worktreePath?: string;
}

/** Four-state dot (P2): the oma TUI publishes working/blocked/idle; a
 *  shell pane or a dead process falls back to the plain two-state dot. */
export function terminalDot(term: { status: string; agentState?: string }): {
  mark: string;
  cls: string;
  label: string;
} {
  if (term.status === "exited") {
    return { mark: "○", cls: "text-(--mute)", label: "exited" };
  }
  if (term.agentState === "blocked") {
    return { mark: "◉", cls: "text-(--warn)", label: "blocked" };
  }
  if (term.agentState === "working") {
    return { mark: "●", cls: "animate-pulse text-(--primary)", label: "working" };
  }
  if (term.agentState === "idle") {
    return { mark: "○", cls: "text-(--primary-deep)", label: "idle" };
  }
  return { mark: "●", cls: "text-(--primary)", label: "running" };
}

function dotFor(
  terminals: CodingTerminalRow[],
  projectId: string,
  agentId: string,
): { mark: string; cls: string; label: string } {
  const ts = terminals.filter((x) => x.projectId === projectId && x.agentId === agentId);
  if (ts.length === 0) return { mark: "○", cls: "text-(--faint)", label: "" };
  // Roll up the worktree's panes: blocked outranks working outranks a plain
  // running shell outranks idle outranks exited.
  const rank = (x: CodingTerminalRow): number => {
    if (x.agentState === "blocked") return 0;
    if (x.agentState === "working") return 1;
    if (x.status === "running" && !x.agentState) return 2;
    if (x.agentState === "idle") return 3;
    return 4;
  };
  const best = [...ts].sort((a, b) => rank(a) - rank(b))[0];
  if (best === undefined) return { mark: "○", cls: "text-(--faint)", label: "" };
  return terminalDot(best);
}

/** The scope a terminal lives in, for the rail's rows and for focusing it. */
export function selectionOfTerminal(term: CodingTerminalRow): CodingSelection {
  const selection: CodingSelection = { agentId: term.agentId };
  if (term.projectId !== null) selection.projectId = term.projectId;
  if (term.projectId !== null && isTaskWorktreeCwd(term.cwd)) selection.worktreePath = term.cwd;
  return selection;
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
  const worktrees = data === undefined ? [] : (data.worktrees ?? []);
  const spawn = useSpawnTerminal();
  const agentsQuery = useAgentList();
  const agents = agentsQuery.data ?? [];
  const { data: taskData } = useTaskWorktrees(project.projectId);
  const taskWorktrees = taskData === undefined ? [] : (taskData.worktrees ?? []);
  const createTask = useCreateTaskWorktree(project.projectId);
  const removeTask = useRemoveTaskWorktree(project.projectId);
  const promoteTask = usePromoteTaskWorktree(project.projectId);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [slug, setSlug] = useState("");
  const [taskAgent, setTaskAgent] = useState("");
  const [taskDiff, setTaskDiff] = useState<{ title: string; text: string } | null>(null);

  /** Opens the scope. Clicking a row is the explicit act that starts a terminal there when the
   *  scope has none. */
  function open(agentId: string, worktreePath?: string, title?: string) {
    const selection: CodingSelection = { projectId: project.projectId, agentId };
    const body: { projectId: string; agentId: string; title: string; worktreePath?: string } = {
      projectId: project.projectId,
      agentId,
      title: "bash",
    };
    if (worktreePath !== undefined) {
      selection.worktreePath = worktreePath;
      body.worktreePath = worktreePath;
      if (title !== undefined) body.title = title;
    }
    onSelect(selection);
    // Dedup by the pane's actual cwd: a task row matches only its own
    // path's terminals; the main row matches terminals whose cwd is NOT a
    // task path (main terminals never carry a worktreePath marker).
    const isMain = worktreePath === undefined;
    const has = terminals.some((x) => {
      if (x.projectId !== project.projectId || x.agentId !== agentId) return false;
      return isMain ? !isTaskWorktreeCwd(x.cwd) : x.cwd === worktreePath;
    });
    if (!has) spawn.mutate(body);
  }

  async function attachAgent(agentId: string) {
    const agent = agents.find((a) => a.id === agentId);
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

  async function createSlugWorktree() {
    const s = slug.trim();
    const firstAgent = worktrees.at(0);
    const agentId = taskAgent || (firstAgent === undefined ? "" : firstAgent.agentId);
    if (!s || !agentId) return;
    try {
      await createTask.mutateAsync({ agentId, slug: s });
      setSlug("");
      toast.success(t("Task worktree created"));
    } catch {
      /* mutation hook already toasts */
    }
  }

  /** Two-step removal: attempt WITHOUT force first, so the server tells us
   *  what is actually at risk (uncommitted changes, unmerged commits) and
   *  the second confirmation can name it instead of guessing. */
  async function removeWorktree(tw: { agentId: string; slug: string }) {
    const ok = await confirm({
      title: t(`Remove worktree ${tw.slug}?`),
      description: t("Deletes the checkout and its branch. Close its terminals first."),
    });
    if (!ok) return;
    try {
      await removeTask.mutateAsync({ agentId: tw.agentId, slug: tw.slug, force: false });
      toast.success(t("Worktree removed"));
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      let detail = raw;
      try {
        detail = (JSON.parse(raw) as { error?: string }).error ?? raw;
      } catch {
        /* not a JSON body — use the raw message */
      }
      const discard = await confirm({
        title: t(`Discard work in ${tw.slug}?`),
        description: detail,
        destructive: true,
      });
      if (!discard) return;
      try {
        await removeTask.mutateAsync({ agentId: tw.agentId, slug: tw.slug, force: true });
        toast.success(t("Worktree removed"));
      } catch (retryErr) {
        toast.error(t("Removal failed"), {
          description: retryErr instanceof Error ? retryErr.message : String(retryErr),
        });
      }
    }
  }

  async function showTaskDiff(tw: { agentId: string; slug: string }) {
    try {
      const res = await api.projectWorktreeDiff(project.projectId, tw.agentId, {
        slug: tw.slug,
      });
      setTaskDiff({ title: `${tw.slug} → base`, text: res.diff || t("(no changes)") });
    } catch (err) {
      toast.error(t("Diff failed"), { description: String(err) });
    }
  }

  /** Promote = the same conflict-preflighted base move the project page
   *  offers for main worktrees, scoped to the task branch. Local mirror
   *  only — pushing to origin stays an explicit act on the project page. */
  async function promoteWorktree(tw: { agentId: string; slug: string }) {
    const ok = await confirm({
      title: t(`Promote ${tw.slug} into the base branch?`),
      description: t(
        "Moves the base branch to this task branch's tip (conflict-checked, not pushed).",
      ),
    });
    if (!ok) return;
    promoteTask.mutate({ agentId: tw.agentId, slug: tw.slug });
  }

  const attached = new Set(worktrees.map((wt) => wt.agentId));
  const attachable = agents.filter((a) => a.enabled !== false && !attached.has(a.id));
  const agentNameById = new Map(agents.map((a) => [a.id, a.name] as const));

  return (
    <div>
      {confirmDialog}
      {worktrees.length === 0 ? (
        <div className="px-3 py-1 text-[11px] leading-[1.7] text-(--mute)">
          {t("No worktrees yet — attach an agent to materialize one.")}
        </div>
      ) : null}
      {worktrees.map((wt) => {
        const dot = dotFor(terminals, project.projectId, wt.agentId);
        const active = selected?.projectId === project.projectId && selected.agentId === wt.agentId;
        const memberName = agentNameById.get(wt.agentId) ?? wt.agentId;
        return (
          <Button
            key={wt.agentId}
            variant="ghost"
            onClick={() => open(wt.agentId)}
            title={`${memberName} (${wt.agentId})`}
            className={`h-auto w-full justify-start gap-2 rounded-md px-3 py-1.5 text-left text-xs font-normal hover:bg-(--panel2) ${
              active ? "bg-(--panel2)" : ""
            }`}
          >
            <span className={dot.cls} title={dot.label}>
              {dot.mark}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-(--ink)">{memberName}</span>
              <span className="block truncate text-[10px] text-(--mute)">
                {project.name} · {wt.worktreeReady ? wt.branch : t("not ready")}
                {wt.ahead > 0 ? ` ↑${wt.ahead}` : ""}
              </span>
            </span>
          </Button>
        );
      })}
      {/* Task worktrees (the task axis): slug-scoped checkouts beside the
          agent's main worktree. */}
      {taskWorktrees.map((tw) => {
        const memberName = agentNameById.get(tw.agentId) ?? tw.agentId;
        return (
          <div key={`${tw.agentId}:${tw.slug}`} className="group flex items-center">
            <Button
              variant="ghost"
              onClick={() => open(tw.agentId, tw.path, tw.slug)}
              title={`${tw.slug} · ${memberName} (${tw.agentId})`}
              className="h-auto min-w-0 flex-1 justify-start gap-2 rounded-md py-1 pr-1 pl-6 text-left text-[11px] font-normal hover:bg-(--panel2)"
            >
              <span className="text-(--faint)">↳</span>
              <span className="min-w-0 flex-1 truncate text-(--ink)">{tw.slug}</span>
              <span className="truncate text-[10px] text-(--mute)">{memberName}</span>
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0 text-(--faint) opacity-0 transition-opacity hover:text-(--info) group-hover:opacity-100"
                    onClick={() => void showTaskDiff(tw)}
                  >
                    <FileDiffIcon className="size-3.5" />
                  </Button>
                }
              />
              <TooltipContent>{t("Diff vs base")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0 text-(--faint) opacity-0 transition-opacity hover:text-(--primary) group-hover:opacity-100"
                    onClick={() => void promoteWorktree(tw)}
                  >
                    <CornerUpLeftIcon className="size-3.5" />
                  </Button>
                }
              />
              <TooltipContent>{t("Promote into base")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0 text-(--faint) opacity-0 transition-opacity hover:text-(--err) group-hover:opacity-100"
                    onClick={() => void removeWorktree(tw)}
                  />
                }
              />
              <TooltipContent>{t("Remove worktree")}</TooltipContent>
            </Tooltip>
          </div>
        );
      })}
      <Dialog open={taskDiff !== null} onOpenChange={(open) => (!open ? setTaskDiff(null) : null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">
              {taskDiff === null ? "" : taskDiff.title}
            </DialogTitle>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-(--canvas) p-3 font-mono text-[11px]/relaxed  text-(--ink)">
            {taskDiff === null ? "" : taskDiff.text}
          </pre>
        </DialogContent>
      </Dialog>
      {/* A worktree is the (agent × project) attach product — this entry is
          how you create one; already-attached agents are filtered out. */}
      {attachable.length > 0 ? (
        <div className="px-3 py-1">
          <Select value="" onValueChange={(v) => void attachAgent(v ?? "")}>
            <SelectTrigger className="h-7 w-full text-[11px]">
              <SelectValue placeholder={t("+ attach agent (new worktree)")} />
            </SelectTrigger>
            <SelectContent>
              {attachable.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {worktrees.length > 0 ? (
        <div className="flex items-center gap-1 px-3 py-1">
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createSlugWorktree();
            }}
            placeholder={t("task slug")}
            className="h-7 min-w-0 flex-1 text-[11px]"
          />
          {worktrees.length > 1 ? (
            <Select
              value={taskAgent || worktrees[0]?.agentId || ""}
              onValueChange={(v) => setTaskAgent(v ?? "")}
            >
              <SelectTrigger className="h-7 w-20 text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {worktrees.map((wt) => (
                  <SelectItem key={wt.agentId} value={wt.agentId}>
                    {wt.agentId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  disabled={!slug.trim() || createTask.isPending}
                  onClick={() => void createSlugWorktree()}
                />
              }
            />
            <TooltipContent>{t("git worktree add on a fresh task branch")}</TooltipContent>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}

/** One existing terminal in the inventory: where it lives, who it belongs to, how it is. Focus
 *  only locates it; it never creates anything. */
function InventoryRow({
  term,
  project,
  member,
  onFocus,
}: {
  term: CodingTerminalRow;
  project: ProjectRow | undefined;
  member: string;
  onFocus: (term: CodingTerminalRow) => void;
}) {
  const dot = terminalDot(term);
  let scope = t("Own workspace");
  if (project !== undefined) {
    scope = isTaskWorktreeCwd(term.cwd)
      ? `${project.name} · ${term.cwd.split(".").pop()}`
      : project.name;
  }
  return (
    <li className="border-b border-(--hairline) py-3 last:border-b-0">
      <strong className="block text-[11px] font-[550] wrap-anywhere text-(--ink)">
        {term.title}
      </strong>
      <small className="block text-[10px] leading-[1.7] text-(--mute)">
        {scope} · {member}
      </small>
      <small className="block text-[10px] leading-[1.7] text-(--mute)">
        <span className={dot.cls} title={t(dot.label)}>
          {dot.mark}
        </span>{" "}
        {t(term.status)} · {term.kind === "oma" ? "oma" : t("shell")}
      </small>
      <Button variant="link" className="mt-2 text-[10px]" onClick={() => onFocus(term)}>
        {t("Focus")}
      </Button>
    </li>
  );
}

/** The terminal inventory on top, then the projects and their worktrees. Clicking a worktree
 *  row opens its scope and starts a terminal there when it has none; Focus only locates. */
export function CodingRail({
  terminals,
  selected,
  onSelect,
  onFocus,
}: {
  terminals: CodingTerminalRow[];
  selected: CodingSelection | null;
  onSelect: (sel: CodingSelection) => void;
  onFocus: (sel: CodingSelection, terminalId: string) => void;
}) {
  const projectsQuery = useProjectList();
  const agentsQuery = useAgentList();
  const projects = projectsQuery.data === undefined ? [] : projectsQuery.data.projects;
  const agents = agentsQuery.data ?? [];
  const memberOf = (term: CodingTerminalRow): string => {
    const agent = agents.find((row) => row.id === term.agentId);
    return agent === undefined ? term.agentId : agent.name;
  };

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col overflow-y-auto rounded-xl border border-(--hairline) bg-(--panel)">
      <div className="border-b border-(--hairline) p-[15px] ">
        <h3 className="mb-1 font-mono text-[11px] tracking-[0.8px] text-(--mute)">
          {t("Terminals · all")}
        </h3>
        <p className="mb-2 text-[10px] leading-[1.7] text-(--faint)">
          {t("Focus only brings a view to the front. It never creates a terminal.")}
        </p>
        {terminals.length === 0 ? (
          <p className="text-[11px] leading-[1.7] text-(--mute)">
            {t("No terminal yet. New terminal starts one.")}
          </p>
        ) : (
          <ul>
            {terminals.map((term) => (
              <InventoryRow
                key={term.terminalId}
                term={term}
                project={projects.find((p) => p.projectId === term.projectId)}
                member={memberOf(term)}
                onFocus={(term) => onFocus(selectionOfTerminal(term), term.terminalId)}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-(--mute)">
          {t("Projects")}
        </span>
        {/* Reuses the projects page's dialog: one create flow, one
            validation shape, shared query invalidation. */}
        <ProjectForm />
      </div>
      {projects.length === 0 ? (
        <div className="px-3 py-2 text-xs leading-[1.7] text-(--mute)">
          {t("No projects yet — create one to start coding.")}
        </div>
      ) : null}
      <div className="border-b border-(--hairline) py-1">
        {projects.map((p) => {
          const mine = terminals.filter((x) => x.projectId === p.projectId);
          const blocked = mine.some((x) => x.agentState === "blocked");
          const running = mine.some((x) => x.status === "running");
          // Blocked outranks running when a project's panes are rolled up into one mark.
          let mark = "○";
          let markClass = "text-(--faint)";
          if (running) {
            mark = "●";
            markClass = "text-(--primary)";
          }
          if (blocked) {
            mark = "◉";
            markClass = "text-(--warn)";
          }
          return (
            <div key={p.projectId} className="flex items-center gap-2 px-3 py-1 text-xs">
              <span className={markClass}>{mark}</span>
              <span className="truncate font-medium text-(--ink)">{p.name}</span>
              <span className="ml-auto truncate text-[10px] text-(--mute)">
                {p.defaultBranch ?? "—"}
              </span>
            </div>
          );
        })}
      </div>

      <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-(--mute)">
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
