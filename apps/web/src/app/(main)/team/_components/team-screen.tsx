"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, Users } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Page, PageBody, PageHeader } from "@/components/page";
import { AgentEditorSheet } from "@/components/team/agent-editor-sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { useAgentList, useUpdateAgent } from "@/features/agents/hooks";
import { agentDetailQuery } from "@/features/agents/queries";
import { useAllConversations } from "@/features/conversations/hooks";
import { useHarnessList } from "@/features/models/hooks";
import type { AgentRow } from "@/lib/api";
import { t } from "@/lib/i18n";
import { MemberCard } from "./member-card";
import { MemberDetailDialog } from "./member-detail-dialog";

/** Where the screen opens: on the list, or with one member's detail or editor already open. The
 *  last three are the URLs `/team/<id>`, `/team/<id>/edit` and `/team/new/edit`. */
export type TeamView =
  | { readonly kind: "list" }
  | { readonly kind: "detail"; readonly agentId: string }
  | { readonly kind: "edit"; readonly agentId: string }
  | { readonly kind: "new" };

type SectionId = "pa" | "worker";

const SECTIONS: ReadonlyArray<{ id: SectionId; title: string; explanation: string }> = [
  {
    id: "pa",
    title: "PA type",
    explanation:
      "The members people talk to. Each PA keeps its own identity, workspace and conversations, and discovers workers as it needs them.",
  },
  {
    id: "worker",
    title: "Worker type",
    explanation:
      "Found by capability, within the scope of the work it is given. Several PAs can use the same worker; there is no fixed team membership.",
  },
];

/** Which section a member belongs to. A member whose role was never set is a PA: it is who people
 *  talk to unless it was made a worker. */
function sectionOf(agent: AgentRow): SectionId {
  if (agent.role === "worker") return "worker";
  return "pa";
}

/** One card with its own write: pausing or enabling is this member's only change from the list. */
function MemberCardConnected({
  agent,
  harnessName,
  conversations,
  onView,
  onEdit,
}: {
  agent: AgentRow;
  harnessName: string;
  conversations: number;
  onView: () => void;
  onEdit: () => void;
}) {
  const update = useUpdateAgent(agent.id);
  const { confirm, dialog } = useConfirm();
  const paused = agent.enabled === false;

  async function toggle(): Promise<void> {
    if (!paused) {
      const pause = await confirm({
        title: t("Pause this member from taking new work?"),
        description: t(
          "{name} is left out of what the PA discovers and dispatches to. Its conversations and history stay.",
          { name: agent.name },
        ),
        confirmText: t("Pause new work"),
        cancelText: t("Keep it enabled"),
        destructive: true,
      });
      if (!pause) return;
    }
    update.mutate(
      { enabled: paused },
      {
        onSuccess: () =>
          toast.success(
            paused
              ? t("{name} can take new work again.", { name: agent.name })
              : t("{name} is paused.", { name: agent.name }),
          ),
        onError: (err) =>
          toast.error(t("Could not change the member"), {
            description: err instanceof Error ? err.message : String(err),
          }),
      },
    );
  }

  return (
    <>
      <MemberCard
        agent={agent}
        harnessName={harnessName}
        conversations={conversations}
        onView={onView}
        onEdit={onEdit}
        onToggle={() => void toggle()}
      />
      {dialog}
    </>
  );
}

/** The editor while it is shown. `phase` lets the sheet finish its exit before it is removed. */
interface EditorState {
  agent: AgentRow | null;
  phase: "open" | "closing";
  /** Where to land once the sheet has closed. */
  after?: string;
}

export interface TeamScreenProps {
  view?: TeamView;
}

export function TeamScreen({ view = { kind: "list" } }: TeamScreenProps) {
  const router = useRouter();
  const agentsQuery = useAgentList();
  const agents = (agentsQuery.data ?? []).filter((row) => row.archivedAt === null);
  const { data: harnessData } = useHarnessList();
  const { data: conversations } = useAllConversations();
  const [detailId, setDetailId] = useState<string | null>(
    view.kind === "detail" ? view.agentId : null,
  );
  const [editor, setEditor] = useState<EditorState | undefined>(
    view.kind === "new" ? { agent: null, phase: "open" } : undefined,
  );
  const requestedTab = useSearchParams().get("tab");

  // `/team/<id>/edit`: the member arrives from the registry, then the sheet opens on it.
  const routedEditId = view.kind === "edit" ? view.agentId : null;
  const routedEdit = useQuery({
    ...agentDetailQuery(routedEditId ?? ""),
    enabled: routedEditId !== null,
  });
  const routedEditData = routedEdit.data;
  useEffect(() => {
    if (routedEditId === null || routedEditData === undefined) return;
    setEditor((prev) => prev ?? { agent: routedEditData, phase: "open" });
  }, [routedEditId, routedEditData]);

  const detailAgent = detailId === null ? undefined : agents.find((row) => row.id === detailId);
  const conversationCounts = new Map<string, number>();
  for (const row of conversations ?? []) {
    const owner = row.agentId;
    if (owner === null || owner === undefined) continue;
    conversationCounts.set(owner, (conversationCounts.get(owner) ?? 0) + 1);
  }
  const enabledCount = agents.filter((row) => row.enabled !== false).length;
  const ownedConversations = [...conversationCounts.values()].reduce((sum, n) => sum + n, 0);

  function harnessNameOf(agent: AgentRow): string {
    const entry = harnessData?.harnesses.find((row) => row.key === agent.harness);
    if (entry === undefined) return agent.harness;
    return entry.name;
  }

  function openEditor(agent: AgentRow | null): void {
    setDetailId(null);
    setEditor({ agent, phase: "open" });
  }

  /** The sheet finished closing: remove it, and land where the save or the URL asks. */
  function editorClosed(): void {
    const after = editor?.after;
    setEditor(undefined);
    if (after !== undefined) {
      router.push(after);
      return;
    }
    if (view.kind !== "list") router.push("/team");
  }

  function closeDetail(): void {
    setDetailId(null);
    if (view.kind === "detail") router.push("/team");
  }

  const notFound = view.kind === "edit" && routedEdit.isError;

  return (
    <Page>
      <PageHeader
        kicker="Agent registry"
        title="Agent registry and discovery"
        description="See each agent's capability configuration, its own workspace and its conversations. A PA discovers workers with team_list; no shared team or conversation is required."
        actions={
          <Button onClick={() => openEditor(null)}>
            <Plus /> {t("New member")}
          </Button>
        }
      />
      <PageBody className="space-y-6">
        <section
          data-slot="team-hero"
          className="relative overflow-hidden rounded-[18px] border border-(--primary)/15 bg-(--panel)"
        >
          <span
            aria-hidden
            className="pointer-events-none absolute -top-24 right-0 size-80 rounded-full bg-(--primary)/10 blur-3xl"
          />
          <div className="relative flex flex-col gap-5 p-7  lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-kicker text-(--faint)">
                {t("Discover by capability")}
              </p>
              <h2 className="mt-2 text-[22px] leading-snug font-medium tracking-tight text-(--ink-strong)">
                {t("Discover by capability, dispatch by task.")}
              </h2>
              <p className="mt-2 max-w-xl text-xs/relaxed  text-(--body)">
                {t(
                  "Several PAs can discover and use the same worker. The main conversation belongs to the person and the PA; a worker keeps its own execution context. Enabling only marks the member as available: it starts no process and connects nothing.",
                )}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-7">
              <div>
                <strong className="block text-[28px] leading-none font-medium text-(--primary)">
                  {agentsQuery.isPending ? "—" : agents.length}
                </strong>
                <small className="mt-1 block text-[10px] text-(--mute)">
                  {t("Registered members")}
                </small>
              </div>
              <div>
                <strong className="block text-[28px] leading-none font-medium text-(--primary)">
                  {agentsQuery.isPending ? "—" : enabledCount}
                </strong>
                <small className="mt-1 block text-[10px] text-(--mute)">
                  {t("Available for new work")}
                </small>
              </div>
              <div>
                <strong className="block text-[28px] leading-none font-medium text-(--primary)">
                  {conversations === undefined ? "—" : ownedConversations}
                </strong>
                <small className="mt-1 block text-[10px] text-(--mute)">{t("Conversations")}</small>
              </div>
            </div>
          </div>
        </section>

        {notFound && (
          <EmptyState
            icon={Users}
            title={t("Member not found")}
            description={t("It may have been removed. The registry lists what exists.")}
          />
        )}

        {agentsQuery.isPending ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="h-72 animate-pulse rounded-2xl bg-(--panel)" />
            <div className="h-72 animate-pulse rounded-2xl bg-(--panel)" />
          </div>
        ) : (
          SECTIONS.map((section) => {
            const members = agents.filter((row) => sectionOf(row) === section.id);
            return (
              <section
                key={section.id}
                aria-labelledby={`team-role-${section.id}`}
                className="min-w-0"
              >
                <div className="flex flex-wrap items-center gap-2.5">
                  <h2
                    id={`team-role-${section.id}`}
                    className="text-[19px] font-medium text-(--ink)"
                  >
                    {t(section.title)}
                  </h2>
                  <Badge variant="secondary">{t("{n} members", { n: members.length })}</Badge>
                </div>
                <p className="mt-1.5 mb-4 max-w-3xl text-xs/relaxed  text-(--body)">
                  {t(section.explanation)}
                </p>
                {members.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-(--hairline) px-5 py-6 text-xs text-(--mute)">
                    {t("No member of this type yet.")}
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {members.map((agent) => (
                      <MemberCardConnected
                        key={agent.id}
                        agent={agent}
                        harnessName={harnessNameOf(agent)}
                        conversations={conversationCounts.get(agent.id) ?? 0}
                        onView={() => setDetailId(agent.id)}
                        onEdit={() => openEditor(agent)}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })
        )}
      </PageBody>

      {detailAgent !== undefined && (
        <MemberDetailDialog
          agent={detailAgent}
          requestedTab={view.kind === "detail" ? requestedTab : null}
          onClose={closeDetail}
          onEdit={openEditor}
        />
      )}

      {editor !== undefined && (
        <AgentEditorSheet
          key={editor.agent?.id ?? "new"}
          open={editor.phase === "open"}
          agent={editor.agent}
          onClose={() =>
            setEditor((prev) => (prev === undefined ? prev : { ...prev, phase: "closing" }))
          }
          onClosed={editorClosed}
          onSaved={(id, next) => {
            const base = `/team/${encodeURIComponent(id)}`;
            const after = next === "lark" ? `${base}?tab=lark&setup=lark` : base;
            setEditor((prev) => (prev === undefined ? prev : { ...prev, phase: "closing", after }));
          }}
        />
      )}
    </Page>
  );
}
