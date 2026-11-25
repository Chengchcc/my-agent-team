"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ChevronRight, MessagesSquare } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { AttentionInbox, type InboxState } from "@/components/AttentionInbox";
import { Note } from "@/components/ops/kit";
import { Page, PageBody, PageHeader } from "@/components/page";
import { RunBlockerCard } from "@/components/RunBlockerCard";
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
import { SavedSection } from "@/features/conversations/SavedSection";
import {
  useCancelReminder,
  useCreateReminder,
  useReminders,
  useSnoozeReminder,
} from "@/features/reminders/hooks";
import { attentionQuery, waitingGatesQuery } from "@/features/runs/queries";
import { TasksSection } from "@/features/runs/TasksSection";
import { todayZones } from "@/features/today/zones";
import type { AgentRow } from "@/lib/api";
import { overlineClass } from "@/lib/form-styles";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

/** The date eyebrow, in the prototype's "DAY · WHAT THIS PAGE IS FOR" form. The day is read in
 *  the browser: the server cannot know the viewer's weekday. */
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

function HeroStat({ value, label }: { value: number | string; label: string }) {
  return (
    <span>
      <strong className="mr-[7px] text-[22px] text-(--primary)">{value}</strong>
      <small className="text-[10px] text-(--mute)">{label}</small>
    </span>
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

/** The registry as Today shows it: the workers a PA can discover, each behind its name. The
 *  full registry is the team page's. */
function RegistryAside({ agents }: { agents: AgentRow[] }) {
  const workers = agents.filter((agent) => agent.role === "worker" && agent.archivedAt === null);
  return (
    <section className="rounded-[15px] border border-white/6 bg-(--panel) p-5">
      <p className="text-[10px] tracking-[1.8px] uppercase text-(--faint)">{t("Agent registry")}</p>
      <h2 className="mt-2 mb-3 text-sm font-[550] text-(--ink)">
        {t("Members that can be discovered now")}
      </h2>
      <p className="text-[11px] leading-[1.8] text-(--mute)">
        {t(
          "Team configuration is managed by people. Different PAs can discover the same worker; there is no fixed team membership here. Being registered does not mean a real check has passed.",
        )}
      </p>
      {workers.length === 0 && (
        <p className="mt-3 text-[11px] leading-[1.8] text-(--mute)">
          {t("No worker is registered yet.")}
        </p>
      )}
      {workers.map((worker) => (
        <Collapsible key={worker.id} className="border-t border-(--hairline) py-[11px]">
          <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md text-left text-xs leading-[1.9] text-(--ink) transition-colors hover:text-(--primary)">
            <span className="flex min-w-0 items-center gap-2">
              <RoleAvatar kind="worker" name={worker.name} size="sm" />
              <span className="truncate">{worker.name}</span>
              <span className="text-[10px] text-(--mute)">
                · {worker.enabled === false ? t("paused") : t("enabled")}
              </span>
            </span>
            <ChevronRight className="size-3.5 shrink-0 text-(--mute)" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="my-2 text-[10px] leading-[1.8] wrap-anywhere text-(--mute)">
              {worker.description || t("No capability description yet.")}
              <br />
              {t("Harness")}: {worker.harness}
              <br />
              {t("Capability entries")}: {capabilityEntries(worker)}
              <br />
              {t("Workspace")}:{" "}
              <span className="font-mono">{worker.workspacePath || t("Not available")}</span>
            </p>
            <Link
              href={`/team/${worker.id}`}
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              {t("View member settings")}
            </Link>
          </CollapsibleContent>
        </Collapsible>
      ))}
      <div className="mt-4">
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

  const rooms = conversations ?? [];
  const firstRoom = rooms.at(0);
  const fallback = firstRoom === undefined ? "" : firstRoom.conversationId;
  const target = conversationId || fallback;
  const fireMs = when === "" ? Number.NaN : new Date(when).getTime();
  const canCreate =
    target !== "" && text.trim() !== "" && Number.isFinite(fireMs) && fireMs > Date.now();

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
        className="flex flex-wrap items-start gap-2 px-5 pb-4"
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
        <div className="w-60">
          <Label htmlFor="reminder-conversation" className={overlineClass}>
            {t("Conversation")}
          </Label>
          <Select
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
                  {room.title || room.conversationId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-52">
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
      <div className="px-5 pb-4">
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
  const dayIndex = useDayIndex();
  const agents = agentsQuery.data ?? [];
  const conversations = conversationsQuery.data ?? [];
  const zones = todayZones(attention.data, gates.data ?? []);

  const loading = attention.isPending || gates.isPending;
  let inboxState: InboxState = "ready";
  if (loading) inboxState = "loading";
  if (attention.isError || gates.isError) inboxState = "failed";

  const pas = agents.filter(
    (agent) => agent.role !== "worker" && agent.archivedAt === null && agent.enabled !== false,
  );
  const firstPaMember = pas.at(0);
  const firstPa = firstPaMember === undefined ? "PA" : firstPaMember.name;
  const roots = conversations.filter((room) => room.parentConversationId === null).length;
  const dash = "—";
  let kicker: string | undefined;
  if (dayIndex !== null) {
    kicker = t("{day} · what needs you", { day: t(DAY_KICKER[dayIndex] ?? "Today") });
  }

  return (
    <Page>
      <PageHeader
        kicker={kicker}
        title={t("Leave your attention to what needs your decision.")}
        description={t(
          "Start by messaging the PA from Lark. The web gathers what awaits your decision, the PA's progress and new results.",
        )}
        actions={
          <>
            <Button variant="outline" render={<Link href="/channels" />}>
              {t("Set up Lark")}
            </Button>
            <Button render={<Link href="/chat" />}>{t("Start a conversation")}</Button>
          </>
        }
      />
      <PageBody>
        <section className="relative mb-[26px] overflow-hidden rounded-[20px] border border-[#9ceacc36] bg-[radial-gradient(ellipse_at_95%_0,#78d7bd25,transparent_60%),linear-gradient(130deg,#21313a,#192329)] p-7">
          <h2 className="text-2xl tracking-[-0.8px] text-(--ink-strong)">
            {t("Talk about the work first. The project context belongs to the items.")}
          </h2>
          <p className="mt-2.5 max-w-[640px] text-xs leading-[1.9] text-(--mute)">
            {t(
              "You keep one continuous conversation with the PA behind the bot. One PA can serve several work groups, and one work session can discuss several projects. The basis of each item, what is still ambiguous, and new project proposals can all be checked on the web.",
            )}
          </p>
          <div className="mt-[23px] flex flex-wrap items-center gap-3">
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
          <div className="mt-[18px] flex flex-wrap gap-[25px] border-t border-[#c6f1e015] pt-[18px]">
            <HeroStat
              value={agentsQuery.isSuccess ? pas.length : dash}
              label={t("Personal agents")}
            />
            <HeroStat
              value={conversationsQuery.isSuccess ? roots : dash}
              label={t("Work sessions")}
            />
            <HeroStat value={loading ? dash : zones.needs.length} label={t("need you")} />
            <HeroStat value={loading ? dash : zones.results.length} label={t("unread results")} />
          </div>
        </section>

        <div className="grid grid-cols-1 gap-[23px] lg:grid-cols-[minmax(0,1fr)_250px] xl:grid-cols-[minmax(0,1fr)_290px]">
          <div className="min-w-0">
            <RunBlockerCard />
            <AttentionInbox
              zones={zones}
              state={inboxState}
              onRetry={() => {
                void attention.refetch();
                void gates.refetch();
              }}
            />
            <RemindersSection />
          </div>
          <aside className="min-w-0">
            <RegistryAside agents={agents} />
          </aside>
        </div>

        <div className="mt-[23px] grid grid-cols-1 gap-[23px] xl:grid-cols-2">
          <TasksSection />
          <SavedSection />
        </div>
        <p className="mt-[25px] text-[10px] text-(--faint)">
          {t("oh-my-agent · attention for what needs you.")}
        </p>
      </PageBody>
    </Page>
  );
}
