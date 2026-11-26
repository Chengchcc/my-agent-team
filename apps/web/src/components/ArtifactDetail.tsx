"use client";

import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { fmtBytes } from "@/components/ops/format";
import { Note } from "@/components/ops/kit";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EntityLink } from "@/components/ui/entity-link";
import { RoleAvatar, roleKindOf } from "@/components/ui/role-avatar";
import { useAgentList } from "@/features/agents/hooks";
import {
  artifactKind,
  type DiffRow,
  type DiffRowKind,
  parseDiff,
} from "@/features/artifacts/artifact-view";
import { useArtifactContent, useDeleteArtifact } from "@/features/artifacts/hooks";
import type { ArtifactMeta } from "@/lib/api";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ArtifactPreview, downloadArtifact, storedEncoding } from "./ArtifactPreview";

/** What the document column shows: the file, its diff, or (from a
 *  conversation) its numbered lines to comment on. */
export type ArtifactView = "document" | "diff" | "lines";

const MAX_ROWS = 2000;

const ROW_CLASS: Record<DiffRowKind, string> = {
  add: "bg-[#b4f1d108] text-[#bbe9ce]",
  del: "bg-[#efa49e08] text-[#eeb8b4]",
  ctx: "text-(--body)",
  hunk: "text-[#728b80]",
  meta: "text-(--faint)",
};

const ROW_MARK: Record<DiffRowKind, string> = {
  add: "+",
  del: "\u2212",
  ctx: " ",
  hunk: "@@",
  meta: "",
};

function lineNumbers(row: DiffRow): string {
  const old = row.oldNo === null ? "" : String(row.oldNo);
  const current = row.newNo === null ? "" : String(row.newNo);
  return `${old.padStart(6)}${current.padStart(7)}`;
}

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text;
}

/** A stored diff as it was written. Nothing here is compared with a repository. */
export function ArtifactDiff({ content }: { content: string }) {
  const [selected, setSelected] = useState("");
  const diff = useMemo(() => parseDiff(content), [content]);
  if (diff.files.length === 0) {
    return (
      <div className="space-y-3 px-8 py-7">
        <p className="text-xs text-(--warn)">
          {t("This file does not hold a recognisable diff. Its text is shown as it is stored.")}
        </p>
        <pre className="wrap-anywhere font-mono text-[11px]/[1.8] text-(--body)">{content}</pre>
      </div>
    );
  }
  const file = diff.files.find((candidate) => candidate.path === selected) ?? diff.files[0];
  if (file === undefined) return null;
  const shown = file.rows.slice(0, MAX_ROWS);
  const several = diff.files.length > 1;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 border-b border-(--hairline) px-6 py-[15px] font-mono text-[10px] text-(--mute)">
        <span>{t("{count} files", { count: diff.files.length })}</span>
        <span>
          <span className="text-(--primary)">+{diff.additions}</span>{" "}
          <span className="text-(--err)">−{diff.deletions}</span>
        </span>
      </div>
      <div className={cn("grid", several && "sm:grid-cols-[175px_1fr]")}>
        {several && (
          <div className="border-b border-(--hairline) p-2 sm:border-r sm:border-b-0 sm:px-2.5 sm:py-4">
            {diff.files.map((candidate) => (
              <button
                key={candidate.path}
                type="button"
                onClick={() => setSelected(candidate.path)}
                className={cn(
                  "block w-full rounded-md p-2.5  text-left font-mono text-[10px] transition-colors",
                  candidate.path === file.path
                    ? "bg-[#b4f1d10a] text-(--primary)"
                    : "text-(--mute) hover:text-(--ink)",
                )}
              >
                {candidate.path}
              </button>
            ))}
          </div>
        )}
        <div className="min-h-[230px] overflow-auto bg-[#14191b] py-[15px] font-mono text-[11px]/8">
          {shown.map((row, index) => (
            <div key={index} className={cn("flex whitespace-pre pr-4", ROW_CLASS[row.kind])}>
              <span className="w-14 shrink-0 select-none text-[10px] text-(--faint)">
                {lineNumbers(row)}
              </span>
              <span className="w-5 shrink-0 select-none">{ROW_MARK[row.kind]}</span>
              <span>{row.text}</span>
            </div>
          ))}
          {file.rows.length > MAX_ROWS && (
            <p className="px-5 pt-2 text-[10px] text-(--faint)">
              {t("+{count} more rows", { count: file.rows.length - MAX_ROWS })}
            </p>
          )}
        </div>
      </div>
      <p className="border-t border-(--hairline) px-6 py-[15px] text-[10px]/relaxed text-(--mute)">
        {t(
          "The diff as it was stored. Nothing was compared with a repository, merged or pushed from here.",
        )}
      </p>
    </div>
  );
}

function SideRow({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="border-b border-(--hairline) py-3 last:border-b-0">
      <small className="mb-[5px] block text-[10px] text-(--faint)">{name}</small>
      <div className="wrap-anywhere text-[11px] font-medium">{children}</div>
    </div>
  );
}

/** Where a stored file came from, as the product recorded it. What was not
 *  recorded says so; nothing is inferred. */
function ArtifactSidebar({ artifact }: { artifact: ArtifactMeta }) {
  const { data: agents } = useAgentList();
  const source = artifact.source;
  const agentId = source?.agentId;
  const member = agentId === undefined ? undefined : agents?.find((a) => a.id === agentId);
  let memberName = t("No member recorded");
  if (agentId !== undefined) memberName = agentId;
  if (member !== undefined) memberName = member.name;
  const nameClass = "text-(--primary-deep) hover:text-(--primary)";

  const labels = artifact.labels;
  const resolvedMemberName = labels?.agentName ?? (member !== undefined ? member.name : memberName);

  return (
    <aside className="border-t border-(--hairline) px-5 py-6 md:border-l md:border-t-0">
      <h4 className="mb-[18px] text-[10px] uppercase tracking-[1px] text-(--faint)">
        {t("Source and evidence")}
      </h4>
      <div className="mb-[19px] flex items-center gap-2.5">
        {member !== undefined && (
          <RoleAvatar kind={roleKindOf(member)} name={member.name} size="sm" />
        )}
        <div className="min-w-0">
          {agentId !== undefined ? (
            <Link
              href={`/team/${agentId}`}
              className={cn("block truncate text-[11px] font-[550]", nameClass)}
            >
              {resolvedMemberName}
            </Link>
          ) : (
            <span className="block truncate text-[11px] font-[550] text-(--mute)">
              {resolvedMemberName}
            </span>
          )}
          <small className="block truncate font-mono text-[10px] text-(--faint)">
            {artifact.url}
          </small>
        </div>
      </div>
      <SideRow name={t("Requirement")}>
        {source?.requirementId !== undefined ? (
          <EntityLink
            kind="requirement"
            id={source.requirementId}
            label={labels?.requirementTitle}
            href={`/requirements/${encodeURIComponent(source.requirementId)}`}
          />
        ) : (
          <span className="text-(--mute)">{t("Not recorded")}</span>
        )}
      </SideRow>
      <SideRow name={t("Conversation")}>
        {source?.conversationId !== undefined ? (
          <EntityLink
            kind="conversation"
            id={source.conversationId}
            label={labels?.conversationTitle}
            href={`/chat/${encodeURIComponent(source.conversationId)}`}
          />
        ) : (
          <span className="text-(--mute)">{t("Not recorded")}</span>
        )}
      </SideRow>
      {source?.projectId !== undefined && (
        <SideRow name={t("Project")}>
          <EntityLink
            kind="project"
            id={source.projectId}
            label={labels?.projectName}
            href={`/team/projects/${encodeURIComponent(source.projectId)}`}
          />
        </SideRow>
      )}
      {source?.workflowExecutionId !== undefined && (
        <SideRow name={t("Workflow")}>
          <EntityLink
            kind="execution"
            id={source.workflowExecutionId}
            label={labels?.workflowName}
            showSecondaryId
          />
        </SideRow>
      )}
      <SideRow name={t("Run")}>
        {source?.runId !== undefined ? (
          <EntityLink
            kind="run"
            id={source.runId}
            label={agentId !== undefined ? resolvedMemberName : undefined}
            showSecondaryId
            href={`/system/runs/${encodeURIComponent(source.runId)}`}
          />
        ) : (
          <span className="text-(--mute)">{t("Not recorded")}</span>
        )}
      </SideRow>
      <SideRow name={t("Evidence")}>
        <span className="text-(--warn)">{t("Not available")}</span>
        <Note className="mt-1">
          {t("The product keeps no check, review or revision for a stored file.")}
        </Note>
      </SideRow>
      <p className="mt-4 text-[10px]/[1.8] text-(--faint)">
        {t("Reading this is not approving a merge, and it does not accept a delivery.")}
      </p>
    </aside>
  );
}

/** The detail of one stored file: the document on the left, where it came
 *  from on the right. Reading it changes nothing. `lines` supplies the
 *  commentable-lines view a conversation opens. */
export function ArtifactDetail({
  artifact,
  view,
  lines,
  children,
}: {
  artifact: ArtifactMeta;
  view: ArtifactView;
  lines?: (content: string) => ReactNode;
  children?: ReactNode;
}) {
  const content = useArtifactContent(artifact.url, artifact.updatedAt);
  const data = content.data;

  let body: ReactNode = <p className="px-8 py-10 text-xs text-(--mute)">{t("Loading…")}</p>;
  if (content.isError) {
    body = (
      <p className="px-8 py-10 text-xs text-(--err)">
        {t("The file could not be loaded: {reason}", { reason: reasonOf(content.error) })}
      </p>
    );
  }
  if (data !== undefined && view === "diff") body = <ArtifactDiff content={data.content} />;
  if (data !== undefined && view === "lines" && lines !== undefined) {
    body = lines(data.content);
  }
  if (data !== undefined && view === "document") {
    body = (
      <>
        <ArtifactPreview
          artifact={artifact}
          content={data.content}
          encoding={storedEncoding(data.encoding)}
        />
        {children}
      </>
    );
  }

  return (
    <div className="grid md:grid-cols-[minmax(0,1fr)_230px]">
      <div className="min-h-[320px] min-w-0">{body}</div>
      <ArtifactSidebar artifact={artifact} />
    </div>
  );
}

/** The gallery's detail: a wide dialog over the page. Its actions only read
 *  (download) or act on the file itself (delete, after a confirm). */
export function ArtifactDetailDialog({
  artifact,
  onClose,
}: {
  artifact: ArtifactMeta | null;
  onClose: () => void;
}) {
  const [view, setView] = useState<ArtifactView>("document");
  const { confirm, dialog: confirmDialog } = useConfirm();
  const remove = useDeleteArtifact();
  const isChange = artifact !== null && artifactKind(artifact) === "change";

  async function removeArtifact(): Promise<void> {
    if (artifact === null) return;
    const ok = await confirm({
      title: t('Delete "{name}"?', { name: artifact.filename }),
      description: t("The file is removed from the registry. This cannot be undone."),
      confirmText: t("Delete"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(artifact.url);
      onClose();
    } catch (error) {
      toast.error(t("Delete failed: {reason}", { reason: reasonOf(error) }));
    }
  }

  return (
    <>
      <Dialog
        open={artifact !== null}
        onOpenChange={(next) => {
          if (next) return;
          setView("document");
          onClose();
        }}
      >
        <DialogContent className="gap-0 p-0 sm:max-w-4xl">
          {artifact !== null && (
            <>
              <DialogHeader className="border-b border-(--hairline) px-[25px] py-[18px]">
                <p className="text-[9px] tracking-[1.8px] uppercase text-(--faint)">
                  {t("Evidence gallery")}
                </p>
                <DialogTitle className="truncate text-[18px] font-[550] tracking-[-0.5px]">
                  {artifact.filename}
                </DialogTitle>
                <DialogDescription className="truncate font-mono text-[10px]">
                  {artifact.folder} · {fmtBytes(artifact.size)} ·{" "}
                  {new Date(artifact.updatedAt).toLocaleString()}
                </DialogDescription>
              </DialogHeader>
              <div className="max-h-[66vh] overflow-y-auto">
                <ArtifactDetail artifact={artifact} view={view} />
              </div>
              <DialogFooter className="mt-0 items-center">
                <span className="mr-auto text-[10px] text-(--faint)">
                  {t("Opening this view changes nothing.")}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-(--err)"
                  onClick={() => void removeArtifact()}
                >
                  {t("Delete")}
                </Button>
                <Button variant="outline" size="sm" onClick={() => void downloadArtifact(artifact)}>
                  {t("Download")}
                </Button>
                {isChange && (
                  <Button size="sm" onClick={() => setView(view === "diff" ? "document" : "diff")}>
                    {view === "diff" ? t("Back to the file") : t("View diff")}
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </>
  );
}
