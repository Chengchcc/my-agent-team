"use client";

import { Maximize2, Minimize2, X } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type EditorTab = "form" | "aside";

function tabClass(active: boolean): string {
  return `h-7 rounded px-2.5 text-xs transition-colors ${
    active ? "bg-(--panel2) text-(--ink)" : "text-(--mute) hover:text-(--ink)"
  }`;
}

export interface ResourceEditorSheetProps {
  open: boolean;
  title: string;
  /** The resource kind, as a small overline above the title. */
  kicker?: string;
  description?: string;
  /** Leaves the editor. With unsaved edits, Escape, the close button and the backdrop ask first. */
  onClose: () => void;
  /** The sheet finished its exit and handed focus back; its owner can remove it now. */
  onClosed?: () => void;
  /** Unsaved edits exist, so leaving now would lose them. */
  dirty: boolean;
  /** The structured form. It keeps its own validation and save action. */
  children: ReactNode;
  formLabel?: string;
  /** The PA conversation beside the form. Below `md` it is the second tab. */
  aside?: ReactNode;
  asideLabel?: string;
  /** Fixed under both regions, so cancel and save stay reachable without scrolling. It receives
   *  the guarded close, which asks before discarding unsaved edits. */
  footer: (requestClose: () => void) => ReactNode;
}

/** A wide side sheet for editing one resource with a PA conversation beside the form. The two
 *  regions scroll on their own, the footer never scrolls, and the sheet can grow to the full
 *  page. Below `md` only one region is shown at a time. */
export function ResourceEditorSheet({
  open,
  title,
  kicker,
  description,
  onClose,
  onClosed,
  dirty,
  children,
  formLabel = t("Form"),
  aside,
  asideLabel = t("PA session"),
  footer,
}: ResourceEditorSheetProps) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<EditorTab>("form");
  const regionsRef = useRef<HTMLDivElement>(null);
  const { confirm, dialog } = useConfirm();

  async function leave(): Promise<void> {
    if (dirty) {
      const discard = await confirm({
        title: t("Discard unsaved changes?"),
        description: t(
          "What you edited here is not saved. Leaving now loses it; the conversation stays.",
        ),
        confirmText: t("Discard and leave"),
        cancelText: t("Keep editing"),
        destructive: true,
      });
      if (!discard) return;
    }
    onClose();
  }

  function requestClose(): void {
    void leave();
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
      onOpenChangeComplete={(next) => {
        // Runs after the exit transition, i.e. after focus went back to where it came from.
        if (!next) onClosed?.();
      }}
    >
      <SheetContent
        showCloseButton={false}
        data-slot="resource-editor-sheet"
        data-expanded={expanded ? "" : undefined}
        initialFocus={() =>
          regionsRef.current?.querySelector<HTMLElement>(
            "input:not([type=hidden]), textarea, select",
          )
        }
        className={cn(
          "flex w-[92vw] max-w-[1400px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1400px] motion-reduce:transition-none",
          expanded && "w-screen max-w-none sm:max-w-none",
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-(--hairline) px-6 py-4">
          <div className="min-w-0">
            {kicker && (
              <p className="mb-1 text-[10px] tracking-kicker uppercase text-(--mute)">{kicker}</p>
            )}
            <SheetTitle className="truncate text-left">{title}</SheetTitle>
            {description && (
              <SheetDescription className="truncate text-left">{description}</SheetDescription>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {aside && (
              <div
                role="tablist"
                aria-label={t("Editor panels")}
                className="mr-2 flex items-center gap-0.5 rounded-md border border-(--hairline) p-0.5 md:hidden"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "form"}
                  onClick={() => setTab("form")}
                  className={tabClass(tab === "form")}
                >
                  {formLabel}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "aside"}
                  onClick={() => setTab("aside")}
                  className={tabClass(tab === "aside")}
                >
                  {asideLabel}
                </button>
              </div>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-pressed={expanded}
              aria-label={expanded ? t("Restore to side sheet") : t("Expand to full page")}
              title={expanded ? t("Restore to side sheet") : t("Expand to full page")}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? <Minimize2 /> : <Maximize2 />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Close")}
              title={t("Close")}
              onClick={requestClose}
            >
              <X />
            </Button>
          </div>
        </header>

        <div
          ref={regionsRef}
          className={cn(
            "grid min-h-0 flex-1 grid-cols-1",
            aside ? "md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : "md:grid-cols-1",
          )}
        >
          <section
            aria-label={formLabel}
            className={cn("min-h-0 overflow-y-auto", tab !== "form" && "hidden md:block")}
          >
            {children}
          </section>
          {aside && (
            <section
              aria-label={asideLabel}
              className={cn(
                "min-h-0 md:flex md:flex-col md:border-l md:border-(--hairline)",
                tab !== "aside" && "hidden md:flex",
              )}
            >
              {aside}
            </section>
          )}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-(--hairline) px-6 py-3">
          {footer(requestClose)}
        </footer>
        {dialog}
      </SheetContent>
    </Sheet>
  );
}
