"use client";

import { ArrowLeft, ArrowUpRight, Download, FileText, FolderOpen, Target, X } from "lucide-react";
import Link from "next/link";
import { ArtifactPreview, downloadArtifact, storedEncoding } from "@/components/ArtifactPreview";
import type { ChatInspectorTarget } from "@/components/chat-inspector-context";
import { fmtBytes } from "@/components/ops/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EntityLink, shortEntityId } from "@/components/ui/entity-link";
import { useArtifactContent, useArtifactMeta, useArtifacts } from "@/features/artifacts/hooks";
import { requirementStatusLabel, requirementStatusTone } from "@/features/requirements/graph";
import { useRequirement } from "@/features/requirements/hooks";
import { isRequirementDetail } from "@/features/requirements/queries";
import type { ArtifactMeta } from "@/lib/api";
import { t } from "@/lib/i18n";

interface ChatSidePreviewPaneProps {
  target: ChatInspectorTarget;
  onBack: () => void;
  onClose: () => void;
  onOpenArtifact: (artifact: ArtifactMeta) => void;
  onOpenRequirement: (requirementId: string) => void;
}

function ArtifactSidePreview({
  initial,
  onOpenRequirement,
}: {
  initial: ArtifactMeta;
  onOpenRequirement: (requirementId: string) => void;
}) {
  const { data: freshMeta } = useArtifactMeta(initial.url);
  const artifact = freshMeta ?? initial;
  const contentQuery = useArtifactContent(artifact.url, artifact.updatedAt);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-(--hairline) bg-(--panel)/40 px-4 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-(--ink-strong)">{artifact.filename}</p>
            <p className="mt-0.5 truncate font-mono text-[10px] text-(--faint)">{artifact.url}</p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void downloadArtifact(artifact)}
          >
            <Download className="size-3.5" />
            {t("Download")}
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-(--mute)">
          {artifact.size > 0 && <span className="font-mono">{fmtBytes(artifact.size)}</span>}
          {artifact.mimeType && <span className="font-mono">{artifact.mimeType}</span>}
          {artifact.labels?.agentName && <span>· {artifact.labels.agentName}</span>}
          {artifact.source?.requirementId && (
            <button
              type="button"
              onClick={() => onOpenRequirement(artifact.source!.requirementId!)}
              className="inline-flex items-center gap-1 rounded-full border border-(--primary)/25 bg-(--primary)/8 px-2 py-0.5 text-[10px] text-(--primary) hover:bg-(--primary)/15"
            >
              <Target className="size-2.5" />
              <span className="max-w-[180px] truncate">
                {artifact.labels?.requirementTitle ?? shortEntityId(artifact.source.requirementId)}
              </span>
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-(--canvas)">
        {contentQuery.isPending ? (
          <p className="px-5 py-8 text-xs text-(--mute)">{t("Loading…")}</p>
        ) : contentQuery.isError ? (
          <p role="alert" className="px-5 py-8 text-xs text-(--err)">
            {t("Could not load this artifact.")}
          </p>
        ) : contentQuery.data ? (
          <ArtifactPreview
            artifact={artifact}
            content={contentQuery.data.content}
            encoding={storedEncoding(contentQuery.data.encoding)}
          />
        ) : null}
      </div>
    </div>
  );
}

function RequirementSidePreview({
  requirementId,
  onOpenArtifact,
}: {
  requirementId: string;
  onOpenArtifact: (artifact: ArtifactMeta) => void;
}) {
  const { data: detail, isPending, isError } = useRequirement(requirementId);
  const artifactsQuery = useArtifacts({ requirementId }, { enabled: requirementId !== "" });
  const linkedArtifacts = artifactsQuery.data?.artifacts ?? [];

  if (isPending) {
    return <p className="px-5 py-8 text-xs text-(--mute)">{t("Loading…")}</p>;
  }
  if (isError || !isRequirementDetail(detail)) {
    return (
      <p role="alert" className="px-5 py-8 text-xs text-(--err)">
        {t("This goal does not exist or cannot be read.")}
      </p>
    );
  }

  const req = detail.requirement;
  const status = detail.derivedStatus;

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-xs leading-relaxed text-(--ink)">
      <div className="space-y-2 border-b border-(--hairline) pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={requirementStatusTone(status)}>{requirementStatusLabel(status)}</Badge>
          <span className="font-mono text-[10px] text-(--faint)">
            {t("{n} runs", { n: detail.runs.length })} ·{" "}
            {t("{n} linked artifact(s)", { n: linkedArtifacts.length })}
          </span>
        </div>
        <h3 className="text-base font-[550] text-(--ink-strong)">{req.title}</h3>
      </div>

      <section className="space-y-1.5">
        <p className="text-[10px] uppercase tracking-[0.8px] text-(--faint)">{t("Goal")}</p>
        <p className="whitespace-pre-wrap text-(--ink)">{req.goal}</p>
      </section>

      {req.background && (
        <section className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-[0.8px] text-(--faint)">{t("Background")}</p>
          <p className="whitespace-pre-wrap text-(--body)">{req.background}</p>
        </section>
      )}

      {req.expectedDeliverables && (
        <section className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-[0.8px] text-(--faint)">
            {t("Expected deliverables")}
          </p>
          <p className="whitespace-pre-wrap text-(--body)">{req.expectedDeliverables}</p>
        </section>
      )}

      {req.acceptanceCriteria && (
        <section className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-[0.8px] text-(--faint)">
            {t("Acceptance criteria")}
          </p>
          <p className="whitespace-pre-wrap text-(--body)">{req.acceptanceCriteria}</p>
        </section>
      )}

      <section className="space-y-2 border-t border-(--hairline) pt-3">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-(--ink)">
            <FolderOpen className="size-3.5 text-(--primary)" />
            {t("Artifacts")}
            <span className="font-mono text-[10px] text-(--faint)">{linkedArtifacts.length}</span>
          </p>
          <Link
            href={`/artifacts?requirement=${encodeURIComponent(requirementId)}`}
            className="inline-flex items-center gap-1 text-[11px] text-(--primary) hover:underline"
          >
            {t("Open in Artifacts")} <ArrowUpRight className="size-3" />
          </Link>
        </div>
        {linkedArtifacts.length === 0 ? (
          <p className="text-[11px] text-(--mute)">{t("No artifacts linked to this goal yet.")}</p>
        ) : (
          <ul className="space-y-1.5">
            {linkedArtifacts.slice(0, 10).map((art) => (
              <li key={art.url}>
                <button
                  type="button"
                  onClick={() => onOpenArtifact(art)}
                  className="flex w-full items-center gap-2 rounded-lg border border-(--hairline) bg-(--panel)/50 px-2.5 py-2 text-left transition-colors hover:border-(--primary)/40 hover:bg-(--panel)"
                >
                  <FileText className="size-3.5 shrink-0 text-(--primary)" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-(--ink)">{art.filename}</p>
                    <p className="truncate font-mono text-[10px] text-(--faint)">
                      {art.labels?.agentName ? `${art.labels.agentName} · ` : ""}
                      {fmtBytes(art.size)}
                    </p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {req.projectId && (
        <div className="border-t border-(--hairline) pt-3">
          <EntityLink
            kind="project"
            id={req.projectId}
            href={`/team/projects/${encodeURIComponent(req.projectId)}`}
            variant="pill"
          />
        </div>
      )}
    </div>
  );
}

/** Antigravity-style right-hand split inspector for previewing artifacts and requirements
 *  side-by-side without leaving the conversation or covering the composer. */
export function ChatSidePreviewPane({
  target,
  onBack,
  onClose,
  onOpenArtifact,
  onOpenRequirement,
}: ChatSidePreviewPaneProps) {
  const fullPageHref =
    target.kind === "requirement"
      ? `/requirements/${encodeURIComponent(target.requirementId)}`
      : `/artifacts?folder=${encodeURIComponent(target.artifact.folder || "")}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-(--canvas)">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-(--hairline) bg-(--panel)/60 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Button type="button" variant="ghost" size="sm" onClick={onBack} className="h-7 px-2">
            <ArrowLeft className="size-3.5" />
            <span>{t("Context")}</span>
          </Button>
          <span className="text-(--hairline)">/</span>
          <span className="inline-flex items-center gap-1 truncate text-xs font-medium text-(--ink)">
            {target.kind === "requirement" ? (
              <Target className="size-3.5 text-(--primary)" />
            ) : (
              <FileText className="size-3.5 text-(--primary)" />
            )}
            {target.kind === "requirement" ? t("Requirement") : t("Artifact")}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={<Link href={fullPageHref} />}
            className="h-7 px-2 text-[11px] text-(--mute) hover:text-(--ink)"
          >
            {t("Open full page")} <ArrowUpRight className="size-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t("Close")}
            title={t("Close")}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {target.kind === "artifact" ? (
        <ArtifactSidePreview initial={target.artifact} onOpenRequirement={onOpenRequirement} />
      ) : (
        <RequirementSidePreview
          requirementId={target.requirementId}
          onOpenArtifact={onOpenArtifact}
        />
      )}
    </div>
  );
}
