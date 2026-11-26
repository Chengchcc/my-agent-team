"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, MessageSquareText, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { OnboardingChecklist } from "@/components/OnboardingChecklist";
import { fmtAgo } from "@/components/ops/format";
import { Note } from "@/components/ops/kit";
import { Page, PageBody, PageHeader } from "@/components/page";
import { ActiveFilterBar, type ActiveFilterChip } from "@/components/ui/active-filter-bar";
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
import { entityLabelText } from "@/components/ui/entity-link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RoleAvatar, roleKindOf } from "@/components/ui/role-avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAgentList } from "@/features/agents/hooks";
import {
  useConversationSearch,
  useCreateConversation,
  useRecentConversations,
} from "@/features/conversations/hooks";
import {
  ALL,
  conversationOverview,
  isWorkConversation,
  type OverviewConversation,
  type PaLike,
  SOURCE_FILTERS,
  SOURCE_WORD,
} from "@/features/conversations/overview";
import { filteredConversationsQuery } from "@/features/conversations/queries";
import { useProjectList } from "@/features/projects/hooks";
import { useRequirement } from "@/features/requirements/hooks";
import { isRequirementDetail } from "@/features/requirements/queries";
import { attentionQuery } from "@/features/runs/queries";
import type { AgentRow, ProjectRow } from "@/lib/api";
import { conversationDisplayName } from "@/lib/conversation-title";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const TINY_COUNT = "rounded bg-white/5 px-1.5 py-px font-mono text-[10px] text-(--faint)";
const CHIP_ON =
  "border-[#9bddbc60] bg-[#7be4b714] text-(--primary) hover:bg-[#7be4b714] hover:text-(--primary)";
const CARD =
  "rounded-2xl border border-(--hairline) bg-[radial-gradient(ellipse_at_100%_0,#83c7ee12,transparent_50%),linear-gradient(135deg,#212d34,#182126)] p-[23px]";

/** The "no project" choice of the new-conversation form. */
const NO_PROJECT = "none";

function sourceWord(origin: string): string {
  const word = SOURCE_WORD[origin];
  if (word === undefined) return origin;
  return t(word);
}

function roomHref(conversationId: string): string {
  return `/chat/${encodeURIComponent(conversationId)}`;
}

/** How many of a conversation's items wait for the person. Said only once the attention list has
 *  been read: an unread list would make every room look free. */
function NeedPill({ known, count }: { known: boolean; count: number }) {
  if (!known) return null;
  if (count > 0) {
    return <Badge variant="wait">{t("{n} need your decision", { n: count })}</Badge>;
  }
  return <Badge variant="secondary">{t("nothing waiting on you")}</Badge>;
}

function ConversationCard({
  conversation,
  pa,
  needKnown,
  now,
}: {
  conversation: OverviewConversation;
  /** The member whose group the conversation sits in; undefined when it is not in the registry. */
  pa: PaLike | undefined;
  needKnown: boolean;
  now: number | null;
}) {
  const title = conversationDisplayName(conversation);
  const href = roomHref(conversation.conversationId);
  const created = now === null ? "—" : new Date(conversation.createdAt).toLocaleString();
  const ago = now === null ? "—" : fmtAgo(conversation.lastActivityAt ?? null, now);
  return (
    <article className={CARD}>
      <div className="flex items-center gap-3.5">
        <RoleAvatar
          kind={pa === undefined ? "pa" : roleKindOf(pa)}
          name={pa === undefined ? "?" : pa.name}
        />
        <div className="min-w-0 flex-1">
          <strong className="block text-[17px] leading-[1.7] font-[550] text-(--ink)">
            <Link href={href} className="transition-colors hover:text-(--primary)">
              {title}
            </Link>
          </strong>
          <p className="mt-1.5 text-[11px] leading-[1.8] text-(--mute)">
            {sourceWord(conversation.origin)} ·{" "}
            {pa === undefined ? t("a member that is no longer registered") : pa.name}
            {conversation.projectName !== null && <> · {conversation.projectName}</>}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          aria-label={t("Open {title}", { title })}
          render={<Link href={href} />}
        >
          <ArrowUpRight className="size-3.5" />
        </Button>
      </div>
      <div className="mt-[17px] flex flex-wrap gap-[7px]">
        <Badge variant="secondary">{sourceWord(conversation.origin)}</Badge>
        {conversation.projectName !== null && (
          <Badge variant="secondary">{conversation.projectName}</Badge>
        )}
        <NeedPill known={needKnown} count={conversation.needYou} />
        {conversation.parentTitle !== null && (
          <Badge variant="secondary">
            {t("dispatched from {title}", { title: conversation.parentTitle })}
          </Badge>
        )}
      </div>
      <div className="mt-[17px] border-t border-(--hairline) pt-[15px]">
        <small suppressHydrationWarning className="text-[10px] leading-[1.8] text-(--mute)">
          {t("Created {created} · last activity {ago}", { created, ago })}
        </small>
      </div>
    </article>
  );
}

/** One conversation with one PA. Opening this dialog creates nothing; Create does. A first
 *  message is optional and, when given, is sent as soon as the conversation opens. */
function NewConversationDialog({
  agents,
  projects,
  open,
  onClose,
}: {
  agents: AgentRow[];
  projects: ProjectRow[];
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const create = useCreateConversation();
  const [paId, setPaId] = useState("");
  const [project, setProject] = useState(NO_PROJECT);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (open) {
      setPaId("");
      setProject(NO_PROJECT);
      setMessage("");
    }
  }, [open]);

  // ADR 0049/0050: people talk to PAs; workers are reached through a dispatch.
  const fronts = agents.filter(
    (agent) => agent.role !== "worker" && agent.archivedAt === null && agent.enabled !== false,
  );
  let selected = fronts.find((agent) => agent.id === paId);
  if (selected === undefined) selected = fronts.at(0);
  const attached = selected === undefined ? [] : (selected.projects ?? []);
  const projectOptions = projects.filter((row) => attached.includes(row.projectId));

  function start() {
    if (selected === undefined || create.isPending) return;
    const body: { agentId: string; projectId?: string } = { agentId: selected.id };
    if (project !== NO_PROJECT) body.projectId = project;
    create.mutate(body, {
      onSuccess: (conversation) => {
        let href = roomHref(conversation.conversationId);
        const first = message.trim();
        if (first !== "") href += `?initial=${encodeURIComponent(first)}`;
        onClose();
        router.push(href);
      },
      onError: (err) =>
        toast.error(t("The conversation was not created"), {
          description: err instanceof Error ? err.message : String(err),
        }),
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("New conversation")}</DialogTitle>
          <DialogDescription>
            {t(
              "Opens a conversation with one PA. A first message is optional; when given, it is sent as soon as the conversation opens.",
            )}
          </DialogDescription>
        </DialogHeader>
        {fronts.length === 0 ? (
          <p role="status" className="text-xs text-(--mute)">
            {t("There is no PA to talk to yet. Create one on the team page first.")}
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-col gap-2">
              <Label
                htmlFor="new-conversation-pa"
                className="text-[11px] font-normal text-(--mute)"
              >
                {t("PA")}
              </Label>
              <Select
                items={fronts.map((agent) => ({ value: agent.id, label: agent.name }))}
                value={selected === undefined ? "" : selected.id}
                onValueChange={(value) => {
                  setPaId(value ?? "");
                  setProject(NO_PROJECT);
                }}
              >
                <SelectTrigger id="new-conversation-pa" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {fronts.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label
                htmlFor="new-conversation-project"
                className="text-[11px] font-normal text-(--mute)"
              >
                {t("Project (optional)")}
              </Label>
              <Select
                items={[
                  { value: NO_PROJECT, label: t("No project") },
                  ...projectOptions.map((row) => ({ value: row.projectId, label: row.name })),
                ]}
                value={project}
                onValueChange={(value) => setProject(value ?? NO_PROJECT)}
              >
                <SelectTrigger id="new-conversation-project" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PROJECT}>{t("No project")}</SelectItem>
                  {projectOptions.map((row) => (
                    <SelectItem key={row.projectId} value={row.projectId}>
                      {row.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Note>
                {projectOptions.length === 0
                  ? t("This PA is attached to no project, so its runs start in its own workspace.")
                  : t(
                      "Only the projects this PA is attached to. Runs then start in that project's worktree.",
                    )}
              </Note>
            </div>
            <div className="flex flex-col gap-2">
              <Label
                htmlFor="new-conversation-message"
                className="text-[11px] font-normal text-(--mute)"
              >
                {t("First message (optional)")}
              </Label>
              <Textarea
                id="new-conversation-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder={t("What do you want to work on?")}
                rows={4}
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button disabled={selected === undefined || create.isPending} onClick={start}>
            {message.trim() === "" ? t("Create") : t("Create and send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FilterChip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      aria-pressed={on}
      className={cn("text-(--mute)", on && CHIP_ON)}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function ChatOverviewView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlRequirementId = searchParams.get("requirement") ?? undefined;
  const urlProjectId = searchParams.get("project") ?? undefined;
  const urlAgentId = searchParams.get("agent") ?? undefined;

  const recentQuery = useRecentConversations();
  const filteredQuery = useQuery({
    ...filteredConversationsQuery({
      ...(urlRequirementId ? { requirementId: urlRequirementId } : {}),
      ...(urlProjectId ? { projectId: urlProjectId } : {}),
    }),
    enabled: Boolean(urlRequirementId || urlProjectId),
  });
  const listQuery = urlRequirementId || urlProjectId ? filteredQuery : recentQuery;
  const reqDetail = useRequirement(urlRequirementId ?? "");
  const agentsQuery = useAgentList();
  const projectsQuery = useProjectList();
  const attention = useQuery(attentionQuery());
  const [pa, setPa] = useState(urlAgentId ?? ALL);
  const [source, setSource] = useState<(typeof SOURCE_FILTERS)[number]>("all");
  const [query, setQuery] = useState("");
  const [ledgerQuery, setLedgerQuery] = useState("");
  const [newOpen, setNewOpen] = useState<"closed" | "open">("closed");

  useEffect(() => {
    const timer = setTimeout(() => setLedgerQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const search = useConversationSearch(ledgerQuery, ledgerQuery !== "");
  const hits = search.data === undefined ? [] : (search.data.results ?? []);
  const agents = agentsQuery.data ?? [];
  const conversations = (listQuery.data ?? []).filter(isWorkConversation);
  const projects = projectsQuery.data === undefined ? [] : projectsQuery.data.projects;
  const awaiting = attention.data === undefined ? [] : attention.data.awaitingYou;

  const overviewAll = conversationOverview({
    conversations,
    pas: agents,
    projects,
    awaiting,
    filters: { pa: ALL, source: "all", query: "" },
  });
  // A filter that names a member with no conversation left falls back to every member.
  const paKnown = overviewAll.chips.some((chip) => chip.pa.id === pa);
  const overview = conversationOverview({
    conversations,
    pas: agents,
    projects,
    awaiting,
    filters: { pa: paKnown ? pa : ALL, source, query },
  });
  const activePa = paKnown ? pa : ALL;
  const clearFilters = () => {
    setPa(ALL);
    setSource("all");
    setQuery("");
    if (urlRequirementId || urlProjectId || urlAgentId) {
      router.replace("/chat");
    }
  };
  const dropChatParam = (key: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete(key);
    const qs = next.toString();
    router.replace(qs ? `/chat?${qs}` : "/chat");
  };
  const urlChips: ActiveFilterChip[] = [];
  if (urlRequirementId) {
    const reqTitle = isRequirementDetail(reqDetail.data)
      ? reqDetail.data.requirement.title
      : undefined;
    urlChips.push({
      key: "requirement",
      category: t("Requirement"),
      value: entityLabelText("requirement", urlRequirementId, reqTitle),
      href: `/requirements/${encodeURIComponent(urlRequirementId)}`,
      onRemove: () => dropChatParam("requirement"),
    });
  }
  if (urlProjectId) {
    const projName = projects.find((p) => p.projectId === urlProjectId)?.name;
    urlChips.push({
      key: "project",
      category: t("Project"),
      value: entityLabelText("project", urlProjectId, projName),
      href: `/team/projects/${encodeURIComponent(urlProjectId)}`,
      onRemove: () => dropChatParam("project"),
    });
  }
  const conversationById = new Map(conversations.map((c) => [c.conversationId, c] as const));
  const openNew = () => setNewOpen("open");
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
  }, []);
  const needKnown = attention.isSuccess;
  const { counts } = overviewAll;
  const hasFilters = activePa !== ALL || source !== "all" || query.trim() !== "";

  let body: ReactNode;
  if (listQuery.isPending) {
    body = <p className="text-sm text-(--mute)">{t("Loading conversations…")}</p>;
  } else if (listQuery.isError) {
    body = (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-(--err)">
        <span>{t("Could not load the conversations.")}</span>
        <Button size="sm" variant="outline" onClick={() => void listQuery.refetch()}>
          {t("Retry")}
        </Button>
      </div>
    );
  } else if (conversations.length === 0) {
    body = (
      <div className="py-6">
        <MessageSquareText className="mb-3 size-6 text-(--mute)" aria-hidden />
        <p className="text-sm text-(--ink)">{t("No conversations yet")}</p>
        <p className="mt-1 text-xs text-(--mute)">
          {t("Start one with a PA. It is listed here, under that PA.")}
        </p>
        <Button className="mt-4" onClick={openNew}>
          <Plus />
          {t("New conversation")}
        </Button>
        <div className="mt-6">
          <OnboardingChecklist />
        </div>
      </div>
    );
  } else {
    body = (
      <>
        <div className="flex flex-wrap gap-3">
          {overviewAll.chips.map((chip) => {
            const dispatched = chip.conversations - chip.roots;
            const sessionLabel =
              chip.roots === 1
                ? t("{n} work session", { n: 1 })
                : t("{n} work sessions", { n: chip.roots });
            const roleDetail =
              chip.pa.role === "worker"
                ? t("Worker · direct room")
                : (chip.botName ?? t("No Lark bot enabled"));
            return (
              <div
                key={chip.pa.id}
                className="flex items-center gap-2.5 rounded-[11px] border border-(--hairline) p-3"
              >
                <RoleAvatar kind={roleKindOf(chip.pa)} name={chip.pa.name} />
                <div>
                  <strong className="block text-xs font-[550] text-(--ink)">{chip.pa.name}</strong>
                  <small className="mt-1 block text-[10px] text-(--mute)">
                    {roleDetail} · {sessionLabel}
                    {dispatched > 0 ? ` · ${t("{n} dispatched", { n: dispatched })}` : ""}
                  </small>
                </div>
              </div>
            );
          })}
        </div>
        <div
          role="group"
          aria-label={t("Filter by PA")}
          className="flex flex-wrap items-center gap-2"
        >
          <FilterChip on={activePa === ALL} onClick={() => setPa(ALL)}>
            {t("All PAs")}
          </FilterChip>
          {overviewAll.chips.map((chip) => (
            <FilterChip
              key={chip.pa.id}
              on={activePa === chip.pa.id}
              onClick={() => setPa(chip.pa.id)}
            >
              {chip.pa.name}
            </FilterChip>
          ))}
        </div>
        <div
          role="search"
          aria-label={t("Search and source filter")}
          className="flex flex-wrap items-center gap-2"
        >
          {SOURCE_FILTERS.map((key) => (
            <FilterChip key={key} on={source === key} onClick={() => setSource(key)}>
              {key === ALL ? t("All sources") : t(SOURCE_WORD[key] ?? key)}
            </FilterChip>
          ))}
          <div className="relative min-w-[190px] flex-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-(--mute)"
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("Search a conversation, a PA or a project")}
              aria-label={t("Search a conversation, a PA or a project")}
              className="pl-9"
            />
          </div>
        </div>
        <p className="text-[11px] leading-[1.8] text-(--mute)">
          {counts.roots === 1
            ? t("{n} work session", { n: 1 })
            : t("{n} work sessions", { n: counts.roots })}
          {" · "}
          {counts.bySource.dispatch === 1
            ? t("{n} dispatched room", { n: 1 })
            : t("{n} dispatched rooms", { n: counts.bySource.dispatch })}
          {" ("}
          {counts.total === 1
            ? t("{n} conversation total", { n: 1 })
            : t("{n} conversations total", { n: counts.total })}
          {": "}
          {t("{n} started in a chat", { n: counts.bySource.user })}
          {", "}
          {counts.bySource.fork === 1
            ? t("{n} fork", { n: 1 })
            : t("{n} forks", { n: counts.bySource.fork })}
          {") · "}
          {t("Counted by conversation, not by work item.")}
        </p>
        {overview.groups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-(--hairline) p-6 text-[11px] leading-[1.9] text-(--mute)">
            {t("No conversation matches these filters.")}{" "}
            {hasFilters && (
              <Button variant="link" className="min-h-0 p-0 align-baseline" onClick={clearFilters}>
                {t("Clear filters")}
              </Button>
            )}
          </div>
        ) : (
          overview.groups.map((group) => {
            const paOfGroup =
              group.paId === null ? undefined : agents.find((agent) => agent.id === group.paId);
            const need = group.conversations.reduce((sum, item) => sum + item.needYou, 0);
            return (
              <section key={group.paId ?? "none"} className="space-y-[15px]">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="flex items-center gap-[9px] text-sm font-[550] text-(--ink)">
                    <RoleAvatar
                      kind={paOfGroup === undefined ? "pa" : roleKindOf(paOfGroup)}
                      name={paOfGroup === undefined ? "?" : paOfGroup.name}
                      size="sm"
                    />
                    {paOfGroup === undefined ? t("No member") : paOfGroup.name}
                    <span className={TINY_COUNT}>{group.conversations.length}</span>
                  </h2>
                  {needKnown && need > 0 && (
                    <Badge variant="wait">{t("{n} need your decision", { n: need })}</Badge>
                  )}
                </div>
                {group.conversations.map((conversation) => (
                  <ConversationCard
                    key={conversation.conversationId}
                    conversation={conversation}
                    pa={paOfGroup}
                    needKnown={needKnown}
                    now={now}
                  />
                ))}
              </section>
            );
          })
        )}
        {ledgerQuery !== "" && (
          <section className="space-y-2">
            <h2 className="flex items-center gap-[9px] text-sm font-[550] text-(--ink)">
              {t("Messages that contain “{query}”", { query: ledgerQuery })}
            </h2>
            {search.isPending && (
              <p className="text-xs text-(--mute)">{t("Searching messages…")}</p>
            )}
            {search.isError && (
              <p role="alert" className="text-xs text-(--err)">
                {t("The messages could not be searched.")}
              </p>
            )}
            {search.isSuccess && hits.length === 0 && (
              <p className="text-xs text-(--mute)">{t("No message contains this text.")}</p>
            )}
            <ul className="space-y-1">
              {hits.map((hit) => {
                const matched = conversationById.get(hit.conversationId);
                const hitLabel = matched
                  ? conversationDisplayName(matched)
                  : entityLabelText("conversation", hit.conversationId);
                return (
                  <li key={`${hit.conversationId}-${hit.seq}`}>
                    <Link
                      href={`${roomHref(hit.conversationId)}?at=${hit.seq}`}
                      className="block rounded-lg border border-(--hairline) bg-(--canvas-soft)/40 p-3 transition-colors hover:border-(--primary)"
                    >
                      <p className="mb-1 truncate text-[11px] font-medium text-(--mute)">
                        {hitLabel}
                      </p>
                      <p className="line-clamp-2 text-xs text-(--ink)">{hit.snippet}</p>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </>
    );
  }

  return (
    <Page>
      <PageHeader
        kicker={t("Work sessions · every PA")}
        title={t("Work sessions")}
        description={t(
          "Every conversation with a PA, grouped by the PA that owns it. A dispatched room sits with the PA that dispatched it. Starting work does not require a project room.",
        )}
        actions={
          <Button variant="outline" onClick={openNew}>
            <Plus />
            {t("New conversation")}
          </Button>
        }
      />
      <PageBody className="space-y-5">
        <ActiveFilterBar chips={urlChips} onClearAll={clearFilters} />
        <Note className="max-w-3xl text-[11px] leading-[1.8] text-(--mute)">
          {t(
            "A conversation does not record whether it came from a Lark chat or a Lark group. Its only source fact is how it began: started in a chat, forked, or dispatched by a PA.",
          )}
        </Note>
        {body}
        <NewConversationDialog
          agents={agents}
          projects={projects}
          open={newOpen === "open"}
          onClose={() => setNewOpen("closed")}
        />
      </PageBody>
    </Page>
  );
}

export default function ChatOverviewPage() {
  return (
    <Suspense fallback={null}>
      <ChatOverviewView />
    </Suspense>
  );
}
