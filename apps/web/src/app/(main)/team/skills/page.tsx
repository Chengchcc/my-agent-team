"use client";

import { useQueries } from "@tanstack/react-query";
import { Package } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { type AskPaRequest, AskPaSheet } from "@/components/AskPaSheet";
import { InstallPackForm } from "@/components/InstallPackForm";
import { badgeVariantOfTone as badgeOf, Note, type FactTone as Tone } from "@/components/ops/kit";
import { QueryState } from "@/components/ops/QueryState";
import { TargetEvalStrip } from "@/components/ops/TargetEvalStrip";
import { PackFileSearch } from "@/components/PackFileSearch";
import { PackFileViewer } from "@/components/PackFileViewer";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RoleAvatar, roleKindOf } from "@/components/ui/role-avatar";
import { Sheet, SheetContent, SheetFooter, SheetTitle } from "@/components/ui/sheet";
import { useAgentList } from "@/features/agents/hooks";
import {
  useDeletePack,
  useSetAgentsPacks,
  useSkillPackFiles,
  useSkillPackList,
  useSkillPackLockfile,
  useSkillPackSkills,
  useSkillPackValidate,
  useSyncPack,
} from "@/features/skill-packs/hooks";
import {
  type CheckState,
  derivePackFacts,
  hiddenSegment,
  type Materialized,
  packIdsAfter,
  packRevision,
  upstreamChanged,
} from "@/features/skill-packs/pack-model";
import { agentSkillPacksQuery, skillPackFilesQuery } from "@/features/skill-packs/queries";
import type { ApiReturn, api } from "@/lib/api";
import { t } from "@/lib/i18n";

/** Skill packages. Registration, being on disk and the check are three recorded facts and
 *  are stated apart; nothing on this page downloads, installs or runs a skill except the
 *  explicit Sync and Uninstall. File requests refuse hidden paths (`.git/`, dotfiles), which
 *  the backend would otherwise serve, and a pack that is not materialized is never asked. */

type PackEntry = ApiReturn<typeof api.listSkillPacks>[number];
type Skill = ApiReturn<typeof api.getSkillPackSkills>[number];
type FileEntry = { name: string; type: string };

const KIND: Record<PackEntry["sourceKind"], string> = {
  builtin: "BUILTIN",
  git: "GIT",
  zip: "ZIP",
};

const MATERIALIZED: Record<Materialized, { label: string; tone: Tone }> = {
  yes: { label: "yes", tone: "ok" },
  no: { label: "no", tone: "err" },
  installing: { label: "in progress", tone: "warn" },
};

const CHECK: Record<CheckState, { label: string; tone: Tone }> = {
  "not checked": { label: "not checked", tone: "muted" },
  passed: { label: "passed", tone: "ok" },
  failed: { label: "failed", tone: "err" },
};

function Fact({
  name,
  state,
  tone,
  title,
}: {
  name: string;
  state: string;
  tone: Tone;
  title?: string;
}) {
  return (
    <Badge variant={badgeOf(tone)} title={title} className="font-normal">
      <span className="text-(--faint)">{t(name)} ·</span> {t(state)}
    </Badge>
  );
}

function sourceOf(pack: PackEntry): string {
  if (pack.sourceKind === "builtin") return t("Builtin");
  const revision = packRevision(pack.installedRef);
  if (pack.sourceKind === "git") {
    const at = revision === null ? "" : ` @ ${revision}`;
    return `${pack.sourceUrl ?? ""}${at}`;
  }
  return t("ZIP upload");
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function inDir(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

// ── Card ────────────────────────────────────────────────────────────────────────

function PackCard({
  pack,
  check,
  members,
  onView,
  onCheck,
  onAssign,
  onSync,
  onUninstall,
}: {
  pack: PackEntry;
  check: Parameters<typeof derivePackFacts>[1];
  members: number;
  onView: () => void;
  onCheck: () => void;
  onAssign: () => void;
  onSync: () => void;
  onUninstall: () => void;
}) {
  const facts = derivePackFacts(pack, check);
  return (
    <article className="rounded-2xl border border-white/6 bg-(--panel) p-5">
      <p className="text-[10px] tracking-[1.8px] uppercase text-(--faint)">
        {KIND[pack.sourceKind]} · {t("SKILL PACK")}
      </p>
      <h2 className="mt-1.5 text-sm font-[550] text-(--ink)">{pack.name}</h2>
      {pack.description !== "" && <p className="text-xs text-(--mute)">{pack.description}</p>}
      <p className="truncate font-mono text-[10px] text-(--faint)">{sourceOf(pack)}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Fact name="Registered" state="yes" tone="ok" />
        <Fact
          name="Materialized"
          state={MATERIALIZED[facts.materialized].label}
          tone={MATERIALIZED[facts.materialized].tone}
          title={t(
            facts.materializedSource === "check"
              ? "The last check looked at the disk."
              : "From the install record; no check has looked at the disk yet.",
          )}
        />
        <Fact name="Check" state={CHECK[facts.check].label} tone={CHECK[facts.check].tone} />
        <Fact
          name="Members"
          state={t("{count} assigned", { count: members })}
          tone={members > 0 ? "ok" : "muted"}
        />
      </div>
      <p className="mt-3 text-[11px] text-(--mute)">
        {facts.materialized === "yes"
          ? t("Files readable")
          : t("Skill files not available · not materialized")}
      </p>
      {pack.status === "failed" && pack.error !== null && (
        <Note className="mt-1 text-(--err)">{pack.error}</Note>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" onClick={onView}>
          {t("View pack and skills")}
        </Button>
        <Button size="sm" variant="outline" onClick={onCheck}>
          {t("Check")}
        </Button>
        <Button size="sm" variant="outline" onClick={onAssign}>
          {t("Assign members")}
        </Button>
        {pack.sourceKind === "git" && (
          <Button size="sm" variant="outline" onClick={onSync}>
            {t("Sync from Git")}
          </Button>
        )}
        {pack.sourceKind !== "builtin" && (
          <Button size="sm" variant="destructive" onClick={onUninstall}>
            {t("Uninstall")}
          </Button>
        )}
      </div>
    </article>
  );
}

// ── Pack sheet ─────────────────────────────────────────────────────────────────

function SkillFiles({
  packId,
  dir,
  selected,
  onSelect,
}: {
  packId: string;
  dir: string;
  selected: string;
  onSelect: (path: string) => void;
}) {
  const root = useSkillPackFiles(packId, dir, { readable: true });
  const folders =
    root.data?.type === "dir"
      ? (root.data.entries ?? []).filter(
          (entry) => entry.type === "dir" && hiddenSegment(entry.name) === null,
        )
      : [];
  const inner = useQueries({
    queries: folders.map((folder) => skillPackFilesQuery(packId, inDir(dir, folder.name))),
  });
  const files = (entries: FileEntry[]): FileEntry[] =>
    entries.filter((entry) => entry.type === "file" && hiddenSegment(entry.name) === null);

  function link(path: string, label: string): ReactNode {
    return (
      <Button
        key={path}
        variant={path === selected ? "secondary" : "ghost"}
        size="xs"
        className="w-full justify-start font-mono"
        onClick={() => onSelect(path)}
      >
        <span className="truncate">{label}</span>
      </Button>
    );
  }

  if (root.isLoading) return <p className="text-[11px] text-(--mute)">{t("Reading files…")}</p>;
  if (root.data?.type !== "dir") {
    return <p className="text-[11px] text-(--mute)">{t("File not available")}</p>;
  }
  return (
    <div className="space-y-1">
      <ul className="space-y-0.5">
        {files(root.data.entries ?? []).map((entry) => link(inDir(dir, entry.name), entry.name))}
      </ul>
      {folders.map((folder, index) => {
        const path = inDir(dir, folder.name);
        const node = inner[index]?.data;
        const entries = node?.type === "dir" ? files(node.entries ?? []) : [];
        return (
          <details key={path} open>
            <summary className="cursor-pointer py-1 font-mono text-[11px] text-(--mute)">
              {folder.name}/
            </summary>
            <ul className="space-y-0.5 pl-3">
              {entries.map((entry) => link(inDir(path, entry.name), entry.name))}
              {inner[index]?.isError && (
                <li>
                  <Note>{t("File not available")}</Note>
                </li>
              )}
            </ul>
          </details>
        );
      })}
    </div>
  );
}

function PackSheet({
  pack,
  onCheck,
  onAssign,
  onClose,
}: {
  pack: PackEntry;
  onCheck: () => void;
  onAssign: () => void;
  onClose: () => void;
}) {
  const facts = derivePackFacts(pack, null);
  const readable = facts.materialized === "yes";
  const skills = useSkillPackSkills(pack.id, { readable });
  const [picked, setPicked] = useState<string | null>(null);
  const list = skills.data ?? [];
  // The skills endpoint reports each skill as its SKILL.md path: that path is the file to open.
  const first = list[0] === undefined ? "" : list[0].dir;
  const selected = picked ?? first;

  function open(path: string): void {
    if (hiddenSegment(path) !== null) return;
    setPicked(path);
  }

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        showCloseButton={false}
        className="w-[92vw] max-w-[1200px] gap-0 p-0 sm:max-w-[1200px]"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-(--hairline) px-6 py-4">
          <div className="min-w-0">
            <p className="mb-1 text-[10px] tracking-kicker uppercase text-(--mute)">
              {KIND[pack.sourceKind]} · {t("SKILL PACK")}
            </p>
            <SheetTitle className="truncate text-left">{pack.name}</SheetTitle>
            <p className="text-xs text-(--mute)">{pack.description}</p>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label={t("Close")} onClick={onClose}>
            ×
          </Button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[380px_minmax(0,1fr)]">
          <section className="min-h-0 space-y-4 overflow-y-auto border-b border-(--hairline) p-5 md:border-r md:border-b-0">
            <h2 className="text-sm font-[550] text-(--ink)">{t("Skills in this pack")}</h2>
            {!readable && (
              <p className="text-xs text-(--mute)">
                {t("Files are not available: this pack is not materialized on disk")}
              </p>
            )}
            {readable && skills.isError && (
              <p className="text-xs text-(--mute)">{t("Not available")}</p>
            )}
            {readable && skills.isSuccess && list.length === 0 && (
              <p className="text-xs text-(--mute)">{t("The pack holds no skill.")}</p>
            )}
            <ul className="space-y-1">
              {list.map((skill: Skill) => (
                <li key={skill.dir}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full flex-col items-start py-1.5"
                    onClick={() => open(skill.dir)}
                  >
                    <span className="font-mono text-xs text-(--ink)">{skill.name}</span>
                    {skill.description !== "" && (
                      <span className="text-[11px] font-normal text-(--mute)">
                        {skill.description}
                      </span>
                    )}
                  </Button>
                </li>
              ))}
            </ul>
            <div className="space-y-2 border-t border-(--hairline) pt-4">
              <h2 className="text-sm font-[550] text-(--ink)">{t("Skill files")}</h2>
              {readable ? (
                <>
                  <PackFileSearch packId={pack.id} onOpen={open} />
                  {list.map((skill: Skill) => (
                    <div key={skill.dir}>
                      <p className="mb-1 font-mono text-[10px] text-(--faint)">{skill.name}/</p>
                      <SkillFiles
                        packId={pack.id}
                        dir={skill.dir}
                        selected={selected}
                        onSelect={open}
                      />
                    </div>
                  ))}
                </>
              ) : (
                <p className="text-[11px] text-(--mute)">
                  {t("Files are not available: this pack is not materialized on disk")}
                </p>
              )}
            </div>
          </section>
          <section className="min-h-0 overflow-y-auto p-5">
            <PackFileViewer packId={pack.id} path={selected} readable={readable} />
          </section>
        </div>
        <SheetFooter className="flex-row flex-wrap justify-end gap-2 bg-(--canvas-soft)">
          <Button variant="outline" size="sm" onClick={onCheck}>
            {t("Check")}
          </Button>
          <Button size="sm" onClick={onAssign}>
            {t("Assign to members")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ── Dialogs ────────────────────────────────────────────────────────────────────

function CheckDialog({
  pack,
  onClose,
  onView,
}: {
  pack: PackEntry;
  onClose: () => void;
  onView: () => void;
}) {
  const validate = useSkillPackValidate();
  useEffect(() => {
    void validate.refetch();
    // Ask once when the dialog opens; the answer stays in the query cache for the cards.
  }, [validate.refetch]);
  const row = validate.data?.find((entry) => entry.id === pack.id);

  function body(): ReactNode {
    if (validate.isFetching) return <p className="text-xs text-(--mute)">{t("Checking…")}</p>;
    if (validate.isError)
      return (
        <p className="text-xs text-(--err)">
          {t("The check failed: {reason}", { reason: errorText(validate.error) })}
        </p>
      );
    if (row === undefined)
      return (
        <p className="text-xs text-(--mute)">{t("The check returned no row for this pack.")}</p>
      );
    if (row.ok) {
      return (
        <p className="text-xs text-(--ok)">
          {t("Passed: {count} skills with a readable SKILL.md", { count: row.skills })}
        </p>
      );
    }
    return (
      <ul className="space-y-1 text-xs text-(--err)">
        {row.issues.map((issue) => (
          <li key={issue}>{issue}</li>
        ))}
      </ul>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <p className="text-[10px] tracking-kicker uppercase text-(--mute)">{t("CHECK")}</p>
          <DialogTitle>
            {t("Check")} · {pack.name}
          </DialogTitle>
          <DialogDescription>
            {t(
              "The check reads each skill's SKILL.md. It does not run the pack, scan dependencies or verify the source.",
            )}
          </DialogDescription>
        </DialogHeader>
        {body()}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Close")}
          </Button>
          <Button onClick={onView}>{t("View pack and skills")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One member and the pack ids it has, undefined while its list is still loading. */
interface MemberPacks {
  agent: ApiReturn<typeof api.listAgents>[number];
  packIds: string[] | undefined;
}

function AssignDialog({
  pack,
  members,
  onClose,
}: {
  pack: PackEntry;
  members: MemberPacks[];
  onClose: () => void;
}) {
  const saveMany = useSetAgentsPacks();
  const [checked, setChecked] = useState<Readonly<Record<string, boolean>>>(() => {
    const initial: Record<string, boolean> = {};
    for (const member of members) {
      if (member.packIds !== undefined) initial[member.agent.id] = member.packIds.includes(pack.id);
    }
    return initial;
  });
  const changes = useMemo(
    () =>
      members.flatMap((member) => {
        if (member.packIds === undefined) return [];
        const next = packIdsAfter(member.packIds, pack.id, checked[member.agent.id] === true);
        if (next === null) return [];
        return [{ agentId: member.agent.id, packIds: next }];
      }),
    [members, checked, pack.id],
  );

  async function save(): Promise<void> {
    try {
      await saveMany.mutateAsync(changes);
      onClose();
    } catch (error) {
      toast.error(t("Assignment not saved"), { description: errorText(error) });
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("Assign members")} · {pack.name}
          </DialogTitle>
          <DialogDescription>
            {t(
              "Adds or removes only this pack for the members whose box you changed. Other packs of a member stay as they are, and nothing is installed.",
            )}
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {members.map(({ agent, packIds }) => (
            <li key={agent.id}>
              <Label className="flex cursor-pointer items-center gap-3 rounded-lg p-2  text-xs font-normal hover:bg-white/3">
                <Checkbox
                  disabled={packIds === undefined}
                  checked={checked[agent.id] === true}
                  onCheckedChange={(value) =>
                    setChecked((prev) => ({ ...prev, [agent.id]: value === true }))
                  }
                />
                <RoleAvatar kind={roleKindOf(agent)} name={agent.name} size="sm" />
                <span className="text-(--ink)">{agent.name}</span>
                {packIds === undefined && (
                  <span className="ml-auto text-[10px] text-(--mute)">{t("Loading…")}</span>
                )}
              </Label>
            </li>
          ))}
          {members.length === 0 && (
            <li className="px-2 text-xs text-(--mute)">{t("No members yet.")}</li>
          )}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button disabled={saveMany.isPending || changes.length === 0} onClick={() => void save()}>
            {t("Save {count} changes", { count: changes.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LockfileDialog({ onClose }: { onClose: () => void }) {
  const lockfile = useSkillPackLockfile();
  useEffect(() => {
    void lockfile.refetch();
  }, [lockfile.refetch]);
  const json = lockfile.data === undefined ? "" : JSON.stringify(lockfile.data, null, 2);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(json);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <p className="text-[10px] tracking-kicker uppercase text-(--mute)">{t("LOCKFILE")}</p>
          <DialogTitle>{t("Lockfile")}</DialogTitle>
          <DialogDescription>
            {t(
              "Read-only JSON, as the backend writes it. No credentials are in it; select the text to copy it by hand.",
            )}
          </DialogDescription>
        </DialogHeader>
        {lockfile.isFetching && <p className="text-xs text-(--mute)">{t("Loading…")}</p>}
        {lockfile.isError && (
          <p className="text-xs text-(--err)">
            {t("Not available: {reason}", { reason: errorText(lockfile.error) })}
          </p>
        )}
        {lockfile.data !== undefined && (
          <pre className="max-h-[50vh] overflow-auto rounded-lg border border-white/6 bg-(--canvas) p-3 font-mono text-[10px] text-(--body)">
            {json}
          </pre>
        )}
        {copied === "copied" && <p className="text-xs text-(--mute)">{t("Copied.")}</p>}
        {copied === "failed" && (
          <p className="text-xs text-(--mute)">
            {t("The browser refused the clipboard; select the text instead.")}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={json === ""} onClick={() => void copy()}>
            {t("Copy JSON")}
          </Button>
          <Button onClick={onClose}>{t("Close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function SkillPacksPage() {
  const packs = useSkillPackList();
  const agents = useAgentList();
  const validate = useSkillPackValidate();
  const sync = useSyncPack();
  const remove = useDeletePack();
  const { confirm, dialog } = useConfirm();
  const [viewId, setViewId] = useState<string | null>(null);
  const [checkId, setCheckId] = useState<string | null>(null);
  const [assignId, setAssignId] = useState<string | null>(null);
  const [lockfile, setLockfile] = useState<"closed" | "open">("closed");
  const [register, setRegister] = useState<"closed" | "open">("closed");
  const [ask, setAsk] = useState<AskPaRequest | null>(null);

  const memberList = agents.data ?? [];
  const memberPacks = useQueries({
    queries: memberList.map((agent) => agentSkillPacksQuery(agent.id)),
  });
  const members = useMemo<MemberPacks[]>(
    () =>
      memberList.map((agent, index) => ({
        agent,
        packIds: Array.isArray(memberPacks[index]?.data)
          ? (memberPacks[index]?.data as { id: string }[]).map((entry) => entry.id)
          : undefined,
      })),
    [memberList, memberPacks],
  );

  const list = packs.data ?? [];
  const checks = validate.data ?? [];
  const askRequest: AskPaRequest = {
    title: t("Skill packages"),
    description: t("Advice only: the PA has no tool that manages skill packs."),
    draft: t(
      "Which skill packs are worth keeping, and is any of them assigned to members who do not use it?",
    ),
  };

  function find(id: string | null): PackEntry | undefined {
    if (id === null) return undefined;
    return list.find((pack) => pack.id === id);
  }

  async function syncPack(pack: PackEntry): Promise<void> {
    const go = await confirm({
      title: t("Sync {name} from Git?", { name: pack.name }),
      description: t(
        "Pulls the pinned revision again from the repository and reinstalls the pack. If the upstream moved, nothing is installed until you confirm the new revision.",
      ),
      confirmText: t("Sync"),
    });
    if (!go) return;
    try {
      await sync.mutateAsync({ id: pack.id });
    } catch (error) {
      const moved = upstreamChanged(error);
      if (moved === null) {
        toast.error(t("Sync failed"), { description: errorText(error) });
        return;
      }
      const accept = await confirm({
        title: t("The upstream moved"),
        description: t(
          "The pinned revision {from} is gone; the repository is at {to}. Sync to the new revision?",
          { from: moved.from.slice(0, 8), to: moved.to.slice(0, 8) },
        ),
        confirmText: t("Sync to the new revision"),
      });
      if (accept) {
        try {
          await sync.mutateAsync({ id: pack.id, confirm: true });
        } catch (retryError) {
          toast.error(t("Sync failed"), { description: errorText(retryError) });
        }
      }
    }
  }

  async function uninstall(pack: PackEntry): Promise<void> {
    const go = await confirm({
      title: t("Uninstall {name}?", { name: pack.name }),
      description: t(
        "Removes the pack and its files. Members that have it keep their other skills. This cannot be undone.",
      ),
      destructive: true,
      confirmText: t("Uninstall"),
    });
    if (!go) return;
    try {
      await remove.mutateAsync(pack.id);
      if (viewId === pack.id) setViewId(null);
    } catch (error) {
      toast.error(t("Uninstall failed"), { description: errorText(error) });
    }
  }

  const viewed = find(viewId);

  return (
    <Page>
      <PageHeader
        kicker="SKILL PACKAGES · REGISTRY"
        title="Skill packages"
        subtitle="See which skills a pack holds, open its description and files, then decide who uses it."
        actions={
          <>
            <Button variant="violet" onClick={() => setAsk(askRequest)}>
              {t("Ask the PA")}
            </Button>
            <Button variant="outline" onClick={() => setLockfile("open")}>
              {t("Lockfile")}
            </Button>
            <Button onClick={() => setRegister("open")}>
              <Package className="size-4" /> {t("Register skill pack")}
            </Button>
          </>
        }
      />
      <PageBody>
        <section className="mb-4 rounded-2xl border border-(--hairline) bg-[linear-gradient(135deg,#1e2c32,#162027)] p-5">
          <p className="text-sm font-[550] text-(--ink)">{t("See what is in a pack first.")}</p>
          <p className="mt-1 max-w-3xl text-xs text-(--mute)">
            {t(
              "Registration, being on disk and the check are recorded separately. A materialized pack's SKILL.md and referenced files are readable; a pack that is not on disk says its files are unavailable. Nothing here downloads, installs or runs a skill.",
            )}
          </p>
        </section>
        <div className="mb-4">
          <TargetEvalStrip targetKind="skill" />
        </div>
        <QueryState
          query={packs}
          empty={(data) => data.length === 0}
          emptyTitle={t("No skill packs yet")}
          emptyDescription={t("Register a pack to give members reusable skills.")}
          emptyIcon={Package}
        >
          {(data) => (
            <div className="grid gap-4 md:grid-cols-2">
              {data.map((pack) => {
                const check = checks.find((entry) => entry.id === pack.id) ?? null;
                return (
                  <PackCard
                    key={pack.id}
                    pack={pack}
                    check={check}
                    members={members.filter((member) => member.packIds?.includes(pack.id)).length}
                    onView={() => setViewId(pack.id)}
                    onCheck={() => setCheckId(pack.id)}
                    onAssign={() => setAssignId(pack.id)}
                    onSync={() => void syncPack(pack)}
                    onUninstall={() => void uninstall(pack)}
                  />
                );
              })}
            </div>
          )}
        </QueryState>
        <Note className="mt-4">
          {t(
            "The check covers every pack at once; its result stays until it is run again and is not stored by the backend.",
          )}
        </Note>
      </PageBody>

      {viewed !== undefined && (
        <PackSheet
          pack={viewed}
          onClose={() => setViewId(null)}
          onCheck={() => setCheckId(viewed.id)}
          onAssign={() => setAssignId(viewed.id)}
        />
      )}
      {find(checkId) !== undefined && (
        <CheckDialog
          pack={find(checkId) as PackEntry}
          onClose={() => setCheckId(null)}
          onView={() => {
            setViewId(checkId);
            setCheckId(null);
          }}
        />
      )}
      {find(assignId) !== undefined && (
        <AssignDialog
          pack={find(assignId) as PackEntry}
          members={members}
          onClose={() => setAssignId(null)}
        />
      )}
      {lockfile === "open" && <LockfileDialog onClose={() => setLockfile("closed")} />}
      {register === "open" && <InstallPackForm onClose={() => setRegister("closed")} />}
      <AskPaSheet request={ask} onClose={() => setAsk(null)} />
      {dialog}
    </Page>
  );
}
