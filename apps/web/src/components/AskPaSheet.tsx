"use client";

import { Wand2, X } from "lucide-react";
import { useState } from "react";
import { type ComposerDraft, PaSession } from "@/components/PaSession";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { t } from "@/lib/i18n";

/** What the person may ask the PA about. Only the draft reaches the conversation, and only in
 *  the input: nothing is sent until the person sends it. */
export interface AskPaRequest {
  title: string;
  description?: string;
  draft: string;
}

/** An isolated PA conversation in a side sheet with a request already in the input. Shared by the
 *  pages that hand a question to the PA (the wiki, skill packs, MCP connections, settings). Every
 *  open starts a fresh lazy-created session — nothing is created until the first message is sent,
 *  and it never mixes into the user's main chat history. */
export function AskPaSheet({
  request,
  onClose,
}: {
  /** What to ask, or null while the sheet is closed. */
  request: AskPaRequest | null;
  onClose: () => void;
}) {
  // The request is cleared as soon as the sheet closes; keep the last one for the exit transition.
  const [lastRequest, setLastRequest] = useState<AskPaRequest | null>(null);
  const [openCount, setOpenCount] = useState(0);
  const [draft, setDraft] = useState<ComposerDraft>({ text: "", n: 0 });
  if (request !== null && request !== lastRequest) {
    setLastRequest(request);
    setOpenCount((c) => c + 1);
    setDraft({ text: request.draft, n: draft.n + 1 });
  }
  const shown = request ?? lastRequest;

  /** Puts the request back into the input after it was edited away or sent. */
  function offerDraft(): void {
    if (shown === null) return;
    setDraft({ text: shown.draft, n: draft.n + 1 });
  }

  return (
    <Sheet
      open={request !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        showCloseButton={false}
        data-slot="ask-pa-sheet"
        className="flex w-[92vw] max-w-[860px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[860px]"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-(--hairline) px-6 py-4">
          <div className="min-w-0">
            <p className="mb-1 text-[10px] tracking-kicker uppercase text-(--mute)">
              {t("Ask the PA")}
            </p>
            <SheetTitle className="truncate text-left">{shown?.title ?? ""}</SheetTitle>
            {shown?.description && (
              <SheetDescription className="truncate text-left">
                {shown.description}
              </SheetDescription>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("Close")}
            title={t("Close")}
            onClick={onClose}
          >
            <X />
          </Button>
        </header>
        <PaSession
          origin="ask"
          sessionKey={`ask-${openCount}`}
          draft={draft.n === 0 ? undefined : draft}
          headerAction={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={offerDraft}
              title={t("Puts a request into the input, for you to edit and send")}
            >
              <Wand2 className="size-3.5" />
              {t("Put the request in the input")}
            </Button>
          }
          emptyTitle={shown?.title ?? t("Ask the PA")}
        />
        <p className="shrink-0 border-t border-(--hairline) px-6 py-2 text-[10px] text-(--faint)">
          {t(
            "The request sits in the input for you to edit and send. Opening this panel sends nothing and starts a dedicated session only when you send.",
          )}
        </p>
      </SheetContent>
    </Sheet>
  );
}
