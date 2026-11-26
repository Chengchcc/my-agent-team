"use client";

import { ArrowUpRight, FolderOpen, Target } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { shortEntityId } from "@/components/ui/entity-link";
import { requirementStatusLabel, requirementStatusTone } from "@/features/requirements/graph";
import { useRequirement } from "@/features/requirements/hooks";
import { isRequirementDetail } from "@/features/requirements/queries";
import { t } from "@/lib/i18n";

/** Inline requirement chip inside chat Markdown (ADR 0082 D8): resolves the real
 *  requirement title and derived status, opens a quick read-only preview on click,
 *  and offers direct links to the full requirement and its linked artifacts. */
export function RequirementMarkdownChip({
  requirementId,
  fallback,
}: {
  requirementId: string;
  fallback?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { data } = useRequirement(requirementId);
  const detail = isRequirementDetail(data) ? data : null;
  const req = detail?.requirement ?? null;
  const status = detail?.derivedStatus ?? null;
  const href = `/requirements/${encodeURIComponent(requirementId)}`;

  const label =
    req?.title ??
    (fallback && String(fallback).trim() !== ""
      ? fallback
      : `${t("Requirement")} · ${shortEntityId(requirementId)}`);

  return (
    <>
      <button
        type="button"
        title={req ? `${req.title} (${requirementId})` : requirementId}
        onClick={() => setOpen(true)}
        className="mx-0.5 inline-flex max-w-full items-center gap-1.5 rounded-full border border-(--primary)/25 bg-(--primary)/8 px-2.5 py-0.5 align-baseline text-xs font-medium text-(--primary) transition-colors hover:border-(--primary)/50 hover:bg-(--primary)/14"
      >
        <Target className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
        {status && (
          <span className="shrink-0 text-[10px] text-(--mute)">
            · {requirementStatusLabel(status)}
          </span>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <p className="font-mono text-[10px] uppercase tracking-[0.8px] text-(--faint)">
                {t("Requirement")}
              </p>
              {status && (
                <Badge variant={requirementStatusTone(status)}>
                  {requirementStatusLabel(status)}
                </Badge>
              )}
            </div>
            <DialogTitle className="text-base text-(--ink-strong)">
              {req?.title ?? `${t("Requirement")} · ${shortEntityId(requirementId)}`}
            </DialogTitle>
            <DialogDescription className="font-mono text-[10px]">{requirementId}</DialogDescription>
          </DialogHeader>
          {req ? (
            <div className="space-y-3 text-xs leading-relaxed text-(--ink)">
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-[0.8px] text-(--faint)">
                  {t("Goal")}
                </p>
                <p className="whitespace-pre-wrap">{req.goal}</p>
              </div>
              {req.expectedDeliverables && (
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-[0.8px] text-(--faint)">
                    {t("Expected deliverables")}
                  </p>
                  <p className="whitespace-pre-wrap text-(--body)">{req.expectedDeliverables}</p>
                </div>
              )}
              {req.acceptanceCriteria && (
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-[0.8px] text-(--faint)">
                    {t("Acceptance criteria")}
                  </p>
                  <p className="whitespace-pre-wrap text-(--body)">{req.acceptanceCriteria}</p>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-(--mute)">{t("Loading…")}</p>
          )}
          <DialogFooter className="gap-2">
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link href={`/artifacts?requirement=${encodeURIComponent(requirementId)}`} />}
            >
              <FolderOpen className="size-3.5" /> {t("Artifacts")}
            </Button>
            <Button size="sm" nativeButton={false} render={<Link href={href} />}>
              {t("Open full page")} <ArrowUpRight className="size-3.5" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
