"use client";

import Link from "next/link";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePendingProposals } from "@/features/proposals/hooks";
import { useRequirements } from "@/features/requirements/hooks";
import { t } from "@/lib/i18n";
import { ProposalsView } from "./_components/proposals-view";

/** ADR 0074: the "requirements by goal" view. One row per tracked item; the
 *  status chip is DERIVED (execution/request/acceptance records), so nobody's
 *  summary edit can mark work finished here. */
const STATUS_TONE: Record<string, string> = {
  open: "bg-zinc-500/15 text-zinc-400",
  in_progress: "bg-sky-500/15 text-sky-400",
  waiting_user: "bg-amber-500/15 text-amber-400",
  pending_acceptance: "bg-violet-500/15 text-violet-400",
  done: "bg-emerald-500/15 text-emerald-400",
  cancelled: "bg-zinc-500/10 text-zinc-500",
};

interface RequirementListRow {
  requirementId: string;
  title: string;
  goal: string;
  status: string;
  updatedAt: number;
}

export default function RequirementsPage() {
  const { data, isLoading } = useRequirements();
  const pending = usePendingProposals();
  const rows = (data as { requirements?: RequirementListRow[] } | undefined)?.requirements ?? [];
  const pendingCount =
    (pending.data as { proposals?: unknown[] } | undefined)?.proposals?.length ?? 0;

  return (
    <Page>
      <PageHeader
        title="Requirements"
        description={t(
          "Work goals the assistant tracks — status derives from execution records, not summaries. Proposals are decisions waiting for you; adopting one applies it.",
        )}
      />
      <PageBody>
        <Tabs defaultValue="requirements">
          <TabsList>
            <TabsTrigger value="requirements">{t("Requirements")}</TabsTrigger>
            <TabsTrigger value="proposals">
              {t("Proposals")}
              {pendingCount > 0 ? ` (${pendingCount})` : ""}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="proposals">
            <ProposalsView />
          </TabsContent>
          <TabsContent value="requirements">
            {isLoading ? (
              <p className="text-sm text-(--mute)">{t("Loading…")}</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-(--mute)">
                {t(
                  "No tracked items yet. They appear when the assistant starts a goal worth following.",
                )}
              </p>
            ) : (
              <ul className="space-y-1">
                {rows.map((r) => (
                  <li key={r.requirementId}>
                    <Link
                      href={`/requirements/${r.requirementId}`}
                      className="flex items-center gap-3 rounded-lg border border-(--hairline) px-3 py-2 hover:border-(--primary) transition-colors"
                    >
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] ${STATUS_TONE[r.status] ?? STATUS_TONE.open}`}
                      >
                        {r.status}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-(--ink)">
                        {r.title}
                      </span>
                      <span className="shrink-0 text-[10px] text-(--mute)">
                        {new Date(r.updatedAt).toLocaleString()}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>
      </PageBody>
    </Page>
  );
}
