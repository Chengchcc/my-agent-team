"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AgentRow, ProjectRow } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useSpawnTerminal } from "../hooks";

/** The "no project" choice: a terminal in the member's own workspace (ADR 0073). */
export const NO_PROJECT = "none";

/** What a locate link named, to prefill the form with. */
export interface TerminalPrefill {
  agentId: string;
  projectId?: string;
}

/** The line under the member select: who can be chosen for this scope, and why nobody can. */
function memberHint(project: string, projectKnown: boolean, optionCount: number): string {
  if (optionCount === 0) {
    if (projectKnown) {
      return t("No member is attached to this project. Attach one on the Projects page first.");
    }
    return t("No member can be chosen for this scope.");
  }
  if (project === NO_PROJECT) {
    return t("Every enabled member. A member's workspace is the directory its rooms run in.");
  }
  return t("Only the members attached to the selected project.");
}

/** One new terminal, said in advance: a title, a scope and a member. Opening this dialog
 *  creates nothing; Create starts one real process in that scope. */
export function NewTerminalDialog({
  open,
  onClose,
  agents,
  projects,
  prefill,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  agents: AgentRow[];
  projects: ProjectRow[];
  /** What to prefill: the member and project a locate link named. */
  prefill: TerminalPrefill | null;
  /** The terminal that was created, so the page can focus its pane. */
  onCreated: (terminalId: string) => void;
}) {
  const spawn = useSpawnTerminal();
  const [title, setTitle] = useState("");
  const [project, setProject] = useState(NO_PROJECT);
  const [agentId, setAgentId] = useState("");

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setProject(
      prefill !== null && prefill.projectId !== undefined ? prefill.projectId : NO_PROJECT,
    );
    setAgentId(prefill === null ? "" : prefill.agentId);
  }, [open, prefill]);

  const members = agents.filter((agent) => agent.archivedAt === null && agent.enabled !== false);
  // A project terminal runs in that project's worktree, so only a member attached to the
  // project can have one there.
  const options =
    project === NO_PROJECT
      ? members
      : members.filter((agent) => (agent.projects ?? []).includes(project));
  let selected = options.find((agent) => agent.id === agentId);
  if (selected === undefined) selected = options.at(0);
  const projectKnown = projects.some((row) => row.projectId === project);

  function create() {
    if (selected === undefined || spawn.isPending) return;
    const body: { agentId: string; title: string; projectId?: string } = {
      agentId: selected.id,
      title: title.trim() === "" ? "bash" : title.trim(),
    };
    if (project !== NO_PROJECT) body.projectId = project;
    spawn.mutate(body, {
      onSuccess: (result) => {
        onCreated(result.terminal.terminalId);
        onClose();
      },
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("New terminal")}</DialogTitle>
          <DialogDescription>
            {t(
              "One pane with a shell in the chosen scope. It starts a real process that keeps running when you leave this page.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-terminal-title" className="text-[11px] font-normal text-(--mute)">
              {t("Title")}
            </Label>
            <Input
              id="new-terminal-title"
              value={title}
              maxLength={60}
              placeholder="bash"
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-terminal-project" className="text-[11px] font-normal text-(--mute)">
              {t("Project")}
            </Label>
            <Select value={project} onValueChange={(value) => setProject(value ?? NO_PROJECT)}>
              <SelectTrigger id="new-terminal-project" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PROJECT}>{t("Member's own workspace")}</SelectItem>
                {projects.map((row) => (
                  <SelectItem key={row.projectId} value={row.projectId}>
                    {row.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-terminal-member" className="text-[11px] font-normal text-(--mute)">
              {t("Member")}
            </Label>
            <Select
              value={selected === undefined ? "" : selected.id}
              onValueChange={(value) => setAgentId(value ?? "")}
            >
              <SelectTrigger id="new-terminal-member" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p
              role={options.length === 0 ? "status" : undefined}
              className="text-[10px] leading-[1.7] text-(--mute)"
            >
              {memberHint(project, projectKnown, options.length)}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button disabled={selected === undefined || spawn.isPending} onClick={create}>
            {t("Create terminal")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
