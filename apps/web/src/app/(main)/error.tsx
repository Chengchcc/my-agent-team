"use client";

import { useEffect } from "react";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

/** A page that throws is replaced inside the shell: the root error boundary
 *  sits ABOVE `(main)/layout`, so it used to take the sidebar and top bar down
 *  with it while the source comment claimed otherwise (audit 2026-11-24). This
 *  one is in the (main) segment, so only the page is replaced. */
export default function MainSegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The console's own channel: a crash that never reaches it looks like a
    // blank page with no trail.
    console.error("[page]", error);
  }, [error]);
  return (
    <Page>
      <PageHeader title={t("This page failed to render")} />
      <PageBody>
        <div className="space-y-3">
          <p className="text-sm text-(--mute)">{t("The rest of the console still works.")}</p>
          <pre className="max-h-40 overflow-auto rounded-md border border-(--hairline) bg-(--panel2) p-2 text-xs text-(--err)">
            {error.message}
          </pre>
          <Button variant="outline" size="sm" onClick={reset}>
            {t("Try again")}
          </Button>
        </div>
      </PageBody>
    </Page>
  );
}
