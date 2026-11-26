"use client";

import {
  ArrowUpRight,
  Bot,
  FileText,
  FolderGit2,
  GitBranch,
  MessageSquare,
  Play,
  Target,
  Terminal,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type EntityKind =
  | "agent"
  | "conversation"
  | "requirement"
  | "project"
  | "workflow"
  | "execution"
  | "run"
  | "artifact"
  | "terminal";

const ICON_BY_KIND = {
  agent: Bot,
  conversation: MessageSquare,
  requirement: Target,
  project: FolderGit2,
  workflow: Workflow,
  execution: Play,
  run: GitBranch,
  artifact: FileText,
  terminal: Terminal,
} as const;

const FALLBACK_PREFIX: Record<EntityKind, string> = {
  agent: "Agent",
  conversation: "Conversation",
  requirement: "Requirement",
  project: "Project",
  workflow: "Workflow",
  execution: "Execution",
  run: "Run",
  artifact: "Artifact",
  terminal: "Terminal",
};

export function shortEntityId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…`;
}

/** Human-first display name for any entity reference (ADR 0082 D5): uses the
 *  real label when available, otherwise falls back to `<Kind> · <shortId>`
 *  instead of exposing a raw opaque hash as the primary label. */
export function entityLabelText(kind: EntityKind, id: string, label?: string | null): string {
  const clean = label?.trim();
  if (clean) return clean;
  return `${t(FALLBACK_PREFIX[kind])} · ${shortEntityId(id)}`;
}

export interface EntityLinkProps {
  kind: EntityKind;
  id: string;
  label?: string | null;
  href?: string;
  /** Show muted short monospace ID beside the label (for technical detail views). */
  showSecondaryId?: boolean;
  /** Compact pill style for inline chips / metadata strips. */
  variant?: "inline" | "pill";
  className?: string;
  onClick?: () => void;
}

/** Shared human-first entity reference (ADR 0082 D5): primary text is always
 *  the entity's human-readable name; the technical ID lives in the tooltip or
 *  optional muted secondary text. */
export function EntityLink({
  kind,
  id,
  label,
  href,
  showSecondaryId = false,
  variant = "inline",
  className,
  onClick,
}: EntityLinkProps) {
  const Icon = ICON_BY_KIND[kind];
  const display = entityLabelText(kind, id, label);
  const hasRealLabel = Boolean(label?.trim());
  const tooltip = hasRealLabel ? `${display} (${id})` : id;

  const content = (
    <>
      <Icon className="size-3 shrink-0 opacity-75" aria-hidden />
      <span className="min-w-0 truncate">{display}</span>
      {showSecondaryId && hasRealLabel && (
        <span className="shrink-0 font-mono text-[10px] text-(--faint)">{shortEntityId(id)}</span>
      )}
      {href && variant === "inline" && (
        <ArrowUpRight className="size-3 shrink-0 opacity-60" aria-hidden />
      )}
    </>
  );

  const sharedClass = cn(
    variant === "pill"
      ? "inline-flex max-w-full items-center gap-1.5 rounded-full border border-(--hairline) bg-(--canvas-soft)/80 px-2.5 py-0.5 text-[11px] text-(--ink) transition-colors hover:border-(--primary)/40 hover:text-(--primary)"
      : "inline-flex max-w-full items-center gap-1.5 text-xs font-medium text-(--primary-deep) transition-colors hover:text-(--primary) hover:underline",
    className,
  );

  if (href) {
    return (
      <Link href={href} title={tooltip} className={sharedClass} onClick={onClick}>
        {content}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" title={tooltip} className={sharedClass} onClick={onClick}>
        {content}
      </button>
    );
  }
  return (
    <span title={tooltip} className={cn(sharedClass, "hover:no-underline")}>
      {content}
    </span>
  );
}
