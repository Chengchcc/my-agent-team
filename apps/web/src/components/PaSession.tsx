"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, Wand2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ConversationPanel } from "@/components/ConversationPanel";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAgentList } from "@/features/agents/hooks";
import { useAllConversations, useCreateConversation } from "@/features/conversations/hooks";
import { agentSkillCommandsQuery } from "@/features/skill-packs/queries";
import { useConversation } from "@/hooks/useConversation";
import { type AgentRow, api, type ConversationSnapshot } from "@/lib/api";
import { conversationDisplayName } from "@/lib/conversation-title";
import { t } from "@/lib/i18n";
import type { SkillCommand } from "@/lib/slash-commands";

/** A draft put into the composer; `n` says it is a new one, so the same text can be offered twice. */
export interface ComposerDraft {
  text: string;
  n: number;
}

/** The conversation a PA panel opens on by default: the PA's own most recent one. A worker's
 *  child conversation (workflow origin) is never the place to talk to the PA. */
function latestConversationOf(rows: readonly ConversationSnapshot[], paId: string): string | null {
  const own = rows.filter((row) => row.agentId === paId && row.origin !== "workflow");
  const byActivity = [...own].sort((a, b) => activityAt(b) - activityAt(a));
  const newest = byActivity[0];
  if (newest === undefined) return null;
  return newest.conversationId;
}

function activityAt(row: ConversationSnapshot): number {
  const at = row.lastActivityAt;
  if (at === undefined || at === null) return 0;
  return at;
}

export interface PaPicker {
  personalAgents: AgentRow[];
  activePa: AgentRow | undefined;
  setPaId: (id: string) => void;
  conversationId: string | null;
  conversationRow: ConversationSnapshot | undefined;
  startSession: () => void;
  starting: boolean;
}

/** Which PA to talk to, and which of its conversations to show: the one the person started for
 *  this PA, else its newest. */
export function usePaPicker(): PaPicker {
  const { data: agents } = useAgentList();
  const personalAgents = useMemo(
    () => (agents ?? []).filter((agent) => agent.role !== "worker"),
    [agents],
  );
  const [paId, setPaId] = useState<string | null>(null);
  const chosen = personalAgents.find((agent) => agent.id === paId);
  const activePa = chosen ?? personalAgents[0];

  const { data: conversations } = useAllConversations();
  const [started, setStarted] = useState<{ paId: string; conversationId: string } | null>(null);
  const rows = conversations ?? [];
  const activePaId = activePa?.id ?? "";
  const newestId = useMemo(() => latestConversationOf(rows, activePaId), [rows, activePaId]);
  const own = started !== null && started.paId === activePaId;
  const conversationId = own && started !== null ? started.conversationId : newestId;
  const conversationRow = rows.find((row) => row.conversationId === conversationId);
  const create = useCreateConversation();

  function startSession(): void {
    if (activePa === undefined) return;
    const id = activePa.id;
    create.mutate(
      { agentId: id },
      {
        onSuccess: (made) => setStarted({ paId: id, conversationId: made.conversationId }),
        onError: (err) =>
          toast.error(t("Could not start a conversation"), {
            description: err instanceof Error ? err.message : String(err),
          }),
      },
    );
  }

  return {
    personalAgents,
    activePa,
    setPaId,
    conversationId,
    conversationRow,
    startSession,
    starting: create.isPending,
  };
}

/** The bar above a picked PA session: which PA, which conversation, and the two ways to put a
 *  request into the composer. */
export function PaPickerBar({
  picker,
  onDraft,
  draftLabel,
  draftDisabled,
}: {
  picker: PaPicker;
  /** Puts a request about the resource into the composer, for the person to edit and send. */
  onDraft: () => void;
  draftLabel: string;
  /** There is nothing to put into the composer yet. */
  draftDisabled?: boolean;
}) {
  const { personalAgents, activePa, conversationRow } = picker;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--hairline) px-4 py-2">
      <Select
        value={activePa?.id ?? ""}
        items={personalAgents.map((agent) => ({ value: agent.id, label: agent.name }))}
        onValueChange={(next) => picker.setPaId(next ?? "")}
        disabled={personalAgents.length === 0}
      >
        <SelectTrigger size="sm" className="min-w-36 max-w-56" aria-label={t("PA")}>
          <SelectValue placeholder={t("No PA")} />
        </SelectTrigger>
        <SelectContent>
          {personalAgents.map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>
              {agent.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="min-w-0 flex-1 truncate text-xs text-(--mute)">
        {conversationRow
          ? `${t("In")} ${conversationDisplayName(conversationRow)}`
          : t("No conversation with this PA yet")}
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={activePa === undefined || picker.starting}
        onClick={picker.startSession}
      >
        <Plus /> {t("New session")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={picker.conversationId === null || draftDisabled === true}
        title={t("Puts a request into the input, for you to edit and send")}
        onClick={onDraft}
      >
        <Wand2 /> {draftLabel}
      </Button>
    </div>
  );
}

type SessionState = "starting" | "ready" | "failed";

export interface PaSessionProps {
  conversationId: string | null;
  /** Who answers. It names the skills the composer offers. */
  paId: string;
  /** Create the conversation first (it is idempotent). A resource-bound session is addressed by a
   *  stable id that exists only after the first visit. */
  createOrigin?: string;
  draft?: ComposerDraft;
  emptyTitle?: ReactNode;
  /** Shown above the messages: a suggestion card, a notice. */
  children?: ReactNode;
}

/** The shared conversation panel, bound to one PA session. It mounts the panel only once the
 *  conversation exists, because the panel subscribes as it mounts. */
export function PaSession({
  conversationId,
  paId,
  createOrigin,
  draft,
  emptyTitle,
  children,
}: PaSessionProps) {
  const [state, setState] = useState<SessionState>(
    createOrigin === undefined ? "ready" : "starting",
  );

  useEffect(() => {
    if (createOrigin === undefined || conversationId === null) return;
    let stopped = false;
    let failed = false;
    api
      .createConversation({ conversationId, agentId: paId, origin: createOrigin })
      .catch(() => {
        failed = true;
      })
      .finally(() => {
        if (stopped) return;
        setState(failed ? "failed" : "ready");
      });
    return () => {
      stopped = true;
    };
  }, [conversationId, paId, createOrigin]);

  if (conversationId === null) {
    return (
      <div className="flex flex-1 flex-col items-start gap-3 p-6">
        <p className="text-sm text-(--mute)">
          {paId === ""
            ? t("No PA to ask yet. Create a personal agent first.")
            : t("Start a session with this PA to ask about it.")}
        </p>
      </div>
    );
  }
  if (state === "failed") {
    return (
      <div className="p-6">
        <p role="alert" className="text-sm text-(--warn)">
          {t("Not available: the PA session could not be started.")}
        </p>
      </div>
    );
  }
  if (state === "starting") {
    return (
      <div className="p-6">
        <p className="text-xs text-(--mute)">{t("Opening the PA session…")}</p>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {children}
      <MountedConversation
        conversationId={conversationId}
        paId={paId}
        draft={draft}
        emptyTitle={emptyTitle}
      />
    </div>
  );
}

interface MountedConversationProps {
  conversationId: string;
  paId: string;
  draft: ComposerDraft | undefined;
  emptyTitle?: ReactNode;
}

/** Owns the live subscription, so it exists only while there is a conversation to show. */
function MountedConversation({
  conversationId,
  paId,
  draft,
  emptyTitle,
}: MountedConversationProps) {
  const conversation = useConversation(conversationId);
  // The skills on offer are the ones the agent who actually answers can load. A stable
  // conversation (a workflow's) keeps the agent it was created with, which is not always the
  // PA picked in the bar above it.
  const agentId = conversation.state.agent?.agentId ?? paId;
  const skillsQuery = useQuery({ ...agentSkillCommandsQuery(agentId), enabled: agentId !== "" });
  const skills: readonly SkillCommand[] = skillsQuery.data ?? [];
  return (
    <ConversationPanel
      conversationId={conversationId}
      conversation={conversation}
      skills={skills}
      draft={draft === undefined ? undefined : draft.text}
      marksSeen={false}
      density="panel"
      emptyTitle={emptyTitle}
    />
  );
}
