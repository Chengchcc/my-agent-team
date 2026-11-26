"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  MessageSquare,
  MessagesSquare,
  Target,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { AttentionInbox, type InboxState } from "@/components/AttentionInbox";
import { fmtAgo } from "@/components/ops/format";
import { Note } from "@/components/ops/kit";
import { Page, PageBody, PageHeader } from "@/components/page";
import { RunBlockerCard } from "@/components/RunBlockerCard";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RoleAvatar } from "@/components/ui/role-avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAgentList } from "@/features/agents/hooks";
import { useAllConversations } from "@/features/conversations/hooks";
import { isWorkConversation } from "@/features/conversations/overview";
import { SavedSection } from "@/features/conversations/SavedSection";
import {
  useCancelReminder,
  useCreateReminder,
  useReminders,
  useSnoozeReminder,
} from "@/features/reminders/hooks";
import { requirementStatusLabel, requirementStatusTone } from "@/features/requirements/graph";
import { useRequirements } from "@/features/requirements/hooks";
import { attentionQuery, waitingGatesQuery } from "@/features/runs/queries";
import { TasksSection } from "@/features/runs/TasksSection";
import { todayZones } from "@/features/today/zones";
import type { AgentRow } from "@/lib/api";
import { conversationDisplayName } from "@/lib/conversation-title";
import { overlineClass } from "@/lib/form-styles";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const DAY_KICKER = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const SECTION_LABEL = "flex items-center gap-[9px] text-sm font-[550] text-(--ink)";
const TINY_COUNT = "rounded bg-white/5 px-1.5 py-px font-mono text-[10px] text-(--faint)";
const PANEL = "rounded-2xl border border-white/6 bg-(--panel)";
const TEXT_LINK =
  "inline-flex items-center gap-[5px] text-[11px] text-(--mute) transition-colors hover:text-(--primary)";

function useDayIndex(): number | null {
  const [dayIndex, setDayIndex] = useState<number | null>(null);
  useEffect(() => {
    setDayIndex(new Date().getDay());
  }, []);
  return dayIndex;
}

function KpiCard({
  href,
  value,
  label,
  highlight = "default",
}: {
  href: string;
  value: number | string;
  label: string;
  highlight?: "default" | "warn" | "primary";
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group flex flex-col justify-between rounded-xl border bg-(--panel) px-4 py-3.5 transition-colors hover:border-(--primary)/40",
        highlight === "warn"
          ? "border-(--warn)/45 bg-(--warn)/5"
          : highlight === "primary"
            ? "border-(--primary)/25"
            : "border-white/6",
      )}
    >
      <span className="text-[11px] text-(--mute)">{label}</span>
      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        <strong
          className={cn(
            "font-display text-2xl font-[550] tracking-tight tabular-nums",
            highlight === "warn"
              ? "text-(--warn)"
              : highlight === "primary"
                ? "text-(--primary)"
                : "text-(--ink-strong)",
          )}
        >
          {value}
        </strong>
        <ArrowUpRight className="size-3.5 text-(--faint) transition-colors group-hover:text-(--primary)" />
      </div>
    </Link>
  );
}

function RouteNode({ mark, title, small }: { mark: ReactNode; title: string; small: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-[13px] border border-(--hairline) bg-[#111c2290] px-[15px] py-[13px]">
      {mark}
      <div>
        <strong className="block text-xs font-[550] text-(--ink)">{title}</strong>
        <small className="mt-1 block text-[9px] text-(--mute)">{small}</small>
      </div>
    </div>
  );
}

function capabilityEntries(worker: AgentRow): string {
  if (worker.skills.length === 0) return t("none declared");
  const entries = worker.skills.map((skill) =>
    [skill.id, skill.description].filter(Boolean).join(" · "),
  );
  return entries.join("; ");
}

/** Compact team roster sidebar: shows active PAs and discoverable Workers with 1-click links. */
function RegistryAside({ agents }: { agents: AgentRow[] }) {
  const active = agents.filter((agent) => agent.archivedAt === null);
  const pas = active.filter((agent) => agent.role !== "worker");
  const workers = active.filter((agent) => agent.role === "worker");

  return (
    <section className="rounded-[15px] border border-white/6 bg-(--panel) p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-xs font-[550] text-(--ink-strong)">{t("Team")}</h2>
        <span className={TINY_COUNT}>{active.length}</span>
      </div>

      {pas.length > 0 && (
        <div className="mb-3 space-y-1">
          <p className="text-[10px] uppercase tracking-[1px] text-(--faint)">{t("PA")}</p>
          {pas.map((pa) => (
            <Link
              key={pa.id}
              href={`/team/${encodeURIComponent(pa.id)}`}
              className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs text-(--ink) transition-colors hover:bg-white/4 hover:text-(--primary)"
            >
              <span className="flex min-w-0 items-center gap-2">
                <RoleAvatar kind="pa" name={pa.name} size="sm" />
                <span className="truncate font-medium">{pa.name}</span>
              </span>
              <span className="shrink-0 text-[10px] text-(--mute)">
                {pa.enabled === false ? t("paused") : t("enabled")}
              </span>
            </Link>
          ))}
        </div>
      )}

      <div className="space-y-0.5 border-t border-(--hairline) pt-3">
        <p className="mb-1 text-[10px] uppercase tracking-[1px] text-(--faint)">{t("Worker")}</p>
        {workers.length === 0 ? (
          <p className="py-1 text-[11px] text-(--mute)">{t("No worker is registered yet.")}</p>
        ) : (
          workers.map((worker) => (
            <Collapsible
              key={worker.id}
              className="border-b border-(--hairline)/60 py-1.5 last:border-b-0"
            >
              <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-1 py-0.5 text-left text-xs text-(--ink) transition-colors hover:text-(--primary)">
                <span className="flex min-w-0 items-center gap-2">
                  <RoleAvatar kind="worker" name={worker.name} size="sm" />
                  <span className="truncate">{worker.name}</span>
                  <span className="text-[10px] text-(--mute)">
                    · {worker.enabled === false ? t("paused") : t("enabled")}
                  </span>
                </span>
                <ChevronRight className="size-3.5 shrink-0 text-(--mute)" />
              </CollapsibleTrigger>
              <CollapsibleContent className="px-1 pb-1">
                <p className="my-1.5 text-[10px] leading-[1.7] wrap-anywhere text-(--mute)">
                  {worker.description || t("No capability description yet.")}
                  <br />
                  {t("Harness")}: {worker.harness} · {t("Capability entries")}:{" "}
                  {capabilityEntries(worker)}
                </p>
                <Link
                  href={`/team/${encodeURIComponent(worker.id)}`}
                  className={buttonVariants({ size: "sm", variant: "outline" })}
                >
                  {t("View member settings")}
                </Link>
              </CollapsibleContent>
            </Collapsible>
          ))
        )}
      </div>

      <div className="mt-3 border-t border-(--hairline) pt-2.5">
        <Link href="/team" className={TEXT_LINK}>
          {t("Manage the agent registry")}
          <ChevronRight className="size-3" />
        </Link>
      </div>
    </section>
  );
}

/** Reminders are created, snoozed and cancelled from here and nowhere else on the web. Each
 *  one is tied to one conversation. */
function RemindersSection() {
  const { data: reminders = [] } = useReminders();
  const { data: conversations } = useAllConversations();
  const create = useCreateReminder();
  const snooze = useSnoozeReminder();
  const cancel = useCancelReminder();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [conversationId, setConversationId] = useState("");
  const [text, setText] = useState("");
  const [when, setWhen] = useState("");

  const rooms = (conversations ?? []).filter(isWorkConversation);
  const firstRoom = rooms.at(0);
  const fallback = firstRoom === undefined ? "" : firstRoom.conversationId;
  const target = conversationId || fallback;
  const fireMs = when === "" ? Number.NaN : new Date(when).getTime();
  const canCreate =
    target !== "" && text.trim() !== "" && Number.isFinite(fireMs) && fireMs > Date.now();
  const roomItems = rooms.map((room) => ({
    value: room.conversationId,
    label: conversationDisplayName(room),
  }));

  function schedule() {
    if (!canCreate) return;
    create.mutate({ conversationId: target, text: text.trim(), fireAt: fireMs });
    setText("");
    setWhen("");
  }

  async function cancelReminder(id: string): Promise<void> {
    const ok = await confirm({
      title: t("Cancel this reminder?"),
      description: t("It will not fire. The conversation is not touched."),
      confirmText: t("Cancel reminder"),
      destructive: true,
    });
    if (!ok) return;
    cancel.mutate(id);
  }

  return (
    <section className={PANEL}>
      {confirmDialog}
      <div className="flex items-center justify-between px-5 pt-4 pb-3">
        <h2 className={SECTION_LABEL}>
          {t("Reminders")}
          <span className={TINY_COUNT}>{reminders.length}</span>
        </h2>
      </div>
      <form
        className="flex flex-wrap items-end gap-2 px-5 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          schedule();
        }}
      >
        <div className="min-w-48 flex-1">
          <Label htmlFor="reminder-text" className={overlineClass}>
            {t("Remind me to...")}
          </Label>
          <Input
            id="reminder-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        <div className="w-56">
          <Label htmlFor="reminder-conversation" className={overlineClass}>
            {t("Conversation")}
          </Label>
          <Select
            items={roomItems}
            value={target}
            onValueChange={(value) => setConversationId(value ?? "")}
            disabled={rooms.length === 0}
          >
            <SelectTrigger id="reminder-conversation" className="w-full">
              <SelectValue placeholder={t("Conversation")} />
            </SelectTrigger>
            <SelectContent>
              {rooms.map((room) => (
                <SelectItem key={room.conversationId} value={room.conversationId}>
                  {conversationDisplayName(room)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-48">
          <Label htmlFor="reminder-when" className={overlineClass}>
            {t("When")}
          </Label>
          <Input
            id="reminder-when"
            type="datetime-local"
            value={when}
            onChange={(event) => setWhen(event.target.value)}
          />
        </div>
        <Button type="submit" size="sm" disabled={!canCreate || create.isPending}>
          {t("Schedule")}
        </Button>
      </form>
      <div className="px-5 pb-3">
        <Note>{t("A reminder needs a conversation, a text and a time in the future.")}</Note>
      </div>
      {reminders.length === 0 ? (
        <p className="px-5 pb-4 text-xs text-(--mute)">{t("Nothing scheduled.")}</p>
      ) : (
        <ul>
          {reminders.map((reminder) => (
            <li
              key={reminder.id}
              className="flex items-center justify-between gap-3 border-t border-(--hairline) px-5 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-(--ink)">
                  {reminder.recurrence && <span title={reminder.recurrence}>↻ </span>}
                  {reminder.text}
                </p>
                <p className="text-[10px] text-(--mute)">
                  <Link href={`/chat/${reminder.conversationId}`} className="hover:underline">
                    {reminder.conversationTitle || reminder.conversationId}
                  </Link>{" "}
                  · {new Date(reminder.fireAt).toLocaleString()}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={snooze.isPending}
                  onClick={() => snooze.mutate({ id: reminder.id, fireAt: Date.now() + 3_600_000 })}
                >
                  {t("+1h")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={snooze.isPending}
                  onClick={() =>
                    snooze.mutate({ id: reminder.id, fireAt: Date.now() + 86_400_000 })
                  }
                >
                  {t("+24h")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-(--mute)"
                  disabled={cancel.isPending}
                  onClick={() => void cancelReminder(reminder.id)}
                >
                  {t("Cancel reminder")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function TodayPage() {
  const attention = useQuery(attentionQuery());
  const gates = useQuery(waitingGatesQuery());
  const agentsQuery = useAgentList();
  const conversationsQuery = useAllConversations();
  const requirementsQuery = useRequirements();
  const dayIndex = useDayIndex();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
  }, []);

  const agents = agentsQuery.data ?? [];
  const conversations = conversationsQuery.data ?? [];
  const requirements = requirementsQuery.data?.requirements ?? [];
  const zones = todayZones(attention.data, gates.data ?? []);

  const loading = attention.isPending || gates.isPending;
  let inboxState: InboxState = "ready";
  if (loading) inboxState = "loading";
  if (attention.isError || gates.isError) inboxState = "failed";

  const pas = agents.filter(
    (agent) => agent.role !== "worker" && agent.archivedAt === null && agent.enabled !== false,
  );
  const agentById = new Map(agents.map((a) => [a.id, a] as const));
  const firstPaMember = pas.at(0);
  const firstPa = firstPaMember === undefined ? "PA" : firstPaMember.name;
  const hasConfiguredLark = pas.some(
    (pa) => pa.lark?.enabled === true || Boolean(pa.lark?.appId) || Boolean(pa.lark?.profileRef),
  );

  const workConversations = conversations.filter(isWorkConversation);
  const rootSessions = workConversations
    .filter((room) => (room.parentConversationId ?? null) === null)
    .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt));
  const dispatchedByRoot = new Map<string, number>();
  for (const room of workConversations) {
    if (room.parentConversationId) {
      dispatchedByRoot.set(
        room.parentConversationId,
        (dispatchedByRoot.get(room.parentConversationId) ?? 0) + 1,
      );
    }
  }
  const activeRequirements = requirements.filter(
    (req) => req.status !== "done" && req.status !== "cancelled",
  );
  const isFreshWorkspace =
    conversationsQuery.isSuccess &&
    requirementsQuery.isSuccess &&
    rootSessions.length === 0 &&
    activeRequirements.length === 0;

  const dash = "—";
  let kicker: string | undefined;
  if (dayIndex !== null) {
    kicker = t("{day} · what needs you", { day: t(DAY_KICKER[dayIndex] ?? "Today") });
  }

  return (
    <Page>
      <PageHeader
        kicker={kicker}
        title={t("Today")}
        description={t("Pending decisions, active goals, and recent work sessions at a glance.")}
        actions={
          <>
            {hasConfiguredLark ? (
              <Button variant="outline" nativeButton={false} render={<Link href="/requirements" />}>
                {t("Requirements")}
              </Button>
            ) : (
              <Button variant="outline" nativeButton={false} render={<Link href="/channels" />}>
                {t("Set up Lark")}
              </Button>
            )}
            <Button nativeButton={false} render={<Link href="/chat" />}>
              {t("Start a conversation")}
            </Button>
          </>
        }
      />
      <PageBody>
        {/* Compact actionable KPI strip */}
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiCard
            href="#attention-inbox"
            value={loading ? dash : zones.needs.length}
            label={t("Needs your decision")}
            highlight={!loading && zones.needs.length > 0 ? "warn" : "default"}
          />
          <KpiCard
            href="/requirements"
            value={requirementsQuery.isSuccess ? activeRequirements.length : dash}
            label={t("Active goals")}
            highlight={activeRequirements.length > 0 ? "primary" : "default"}
          />
          <KpiCard
            href="/chat"
            value={conversationsQuery.isSuccess ? rootSessions.length : dash}
            label={t("Work sessions")}
          />
          <KpiCard
            href="#attention-inbox"
            value={loading ? dash : zones.results.length}
            label={t("Unread results")}
            highlight={!loading && zones.results.length > 0 ? "primary" : "default"}
          />
        </div>

        {/* Onboarding explainer only shown when workspace has zero sessions and zero active goals */}
        {isFreshWorkspace && (
          <section className="relative mb-6 overflow-hidden rounded-[20px] border border-[#9ceacc36] bg-[radial-gradient(ellipse_at_95%_0,#78d7bd25,transparent_60%),linear-gradient(130deg,#21313a,#192329)] p-6">
            <h2 className="text-xl tracking-[-0.5px] text-(--ink-strong)">
              {t("Talk about the work first. The project context belongs to the items.")}
            </h2>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <RouteNode
                mark={<RoleAvatar kind="user" name={t("You")} />}
                title={t("You tell the PA the goal")}
                small={t("from Lark, or from the web")}
              />
              <ArrowRight className="size-4 text-(--primary)" />
              <RouteNode
                mark={
                  <span className="grid size-[34px] shrink-0 place-items-center rounded-[11px] border border-(--hairline) bg-(--panel2) text-(--primary)">
                    <MessagesSquare className="size-4" />
                  </span>
                }
                title={t("One bot belongs to one PA")}
                small={t("whether it is connected is a separate fact")}
              />
              <ArrowRight className="size-4 text-(--primary)" />
              <RouteNode
                mark={<RoleAvatar kind="pa" name={firstPa} />}
                title={t("The PA records the work and dispatches")}
                small={t("and comes back only when it needs you")}
              />
            </div>
          </section>
        )}

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_270px] xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 space-y-5">
            <RunBlockerCard />
            <AttentionInbox
              zones={zones}
              state={inboxState}
              onRetry={() => {
                void attention.refetch();
                void gates.refetch();
              }}
            />

            {/* Real active work right above the fold */}
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <section className={cn(PANEL, "flex flex-col p-4")}>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 className={SECTION_LABEL}>
                    <Target className="size-3.5 text-(--primary)" />
                    {t("Active goals")}
                    <span className={TINY_COUNT}>{activeRequirements.length}</span>
                  </h2>
                  <Link href="/requirements" className={TEXT_LINK}>
                    {t("View all")} <ArrowUpRight className="size-3" />
                  </Link>
                </div>
                {activeRequirements.length === 0 ? (
                  <p className="py-4 text-xs text-(--mute)">{t("No active goals yet.")}</p>
                ) : (
                  <ul className="space-y-2">
                    {activeRequirements.slice(0, 4).map((req) => (
                      <li key={req.requirementId}>
                        <Link
                          href={`/requirements/${encodeURIComponent(req.requirementId)}`}
                          className="block rounded-xl border border-(--hairline) bg-(--canvas-soft)/50 p-3 transition-colors hover:border-(--primary)/40 hover:bg-(--canvas-soft)"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="min-w-0 flex-1 truncate text-xs font-medium text-(--ink)">
                              {req.title}
                            </span>
                            <Badge variant={requirementStatusTone(req.status)} className="shrink-0">
                              {requirementStatusLabel(req.status)}
                            </Badge>
                          </div>
                          <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-(--mute)">
                            {req.goal}
                          </p>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className={cn(PANEL, "flex flex-col p-4")}>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 className={SECTION_LABEL}>
                    <MessageSquare className="size-3.5 text-(--primary)" />
                    {t("Recent work sessions")}
                    <span className={TINY_COUNT}>{rootSessions.length}</span>
                  </h2>
                  <Link href="/chat" className={TEXT_LINK}>
                    {t("View all")} <ArrowUpRight className="size-3" />
                  </Link>
                </div>
                {rootSessions.length === 0 ? (
                  <p className="py-4 text-xs text-(--mute)">{t("No conversations yet")}</p>
                ) : (
                  <ul className="space-y-2">
                    {rootSessions.slice(0, 4).map((room) => {
                      const owner = room.agentId ? agentById.get(room.agentId) : undefined;
                      const childCount = dispatchedByRoot.get(room.conversationId) ?? 0;
                      const ago =
                        now === null ? "—" : fmtAgo(room.lastActivityAt ?? room.createdAt, now);
                      return (
                        <li key={room.conversationId}>
                          <Link
                            href={`/chat/${encodeURIComponent(room.conversationId)}`}
                            className="flex items-center gap-2.5 rounded-xl border border-(--hairline) bg-(--canvas-soft)/50 p-3 transition-colors hover:border-(--primary)/40 hover:bg-(--canvas-soft)"
                          >
                            <RoleAvatar kind="pa" name={owner?.name ?? "PA"} size="sm" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-medium text-(--ink)">
                                {conversationDisplayName(room)}
                              </p>
                              <p
                                className="mt-0.5 truncate text-[10px] text-(--mute)"
                                suppressHydrationWarning
                              >
                                {owner?.name ?? t("PA")} · {ago}
                                {childCount > 0
                                  ? ` · ${t("{n} worker sub-sessions", { n: childCount })}`
                                  : ""}
                              </p>
                            </div>
                            <ArrowUpRight className="size-3.5 shrink-0 text-(--faint)" />
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>

            <RemindersSection />
          </div>

          <aside className="min-w-0 space-y-4">
            <RegistryAside agents={agents} />
          </aside>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
          <TasksSection />
          <SavedSection />
        </div>
      </PageBody>
    </Page>
  );
}
