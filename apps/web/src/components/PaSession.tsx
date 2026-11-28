"use client";

import { useQuery } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Composer, type RecommendedSkill } from "@/components/Composer";
import { ConversationPanel } from "@/components/ConversationPanel";
import { ConversationDensityContext } from "@/components/conversation-density";
import type { ChatModelOverride } from "@/components/ModelPicker";
import { Button } from "@/components/ui/button";
import { RoleAvatar } from "@/components/ui/role-avatar";
import { useAgentList } from "@/features/agents/hooks";
import { agentSkillCommandsQuery } from "@/features/skill-packs/queries";
import { useConversation } from "@/hooks/useConversation";
import { type AgentRow, api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { findCommand, type SkillCommand } from "@/lib/slash-commands";

/** A draft put into the composer; `n` says it is a new one, so the same text can be offered twice. */
export interface ComposerDraft {
  text: string;
  n: number;
}

/** Describes the domain skill that creates or modifies the resource beside this session. */
export interface DomainSkillSpec {
  /** Canonical slash command shown even before/without skill pack resolution, e.g. "/member_manage". */
  fallbackCommand: string;
  /** Substring matched against the PA's installed skill commands, e.g. "member". */
  matchKeyword: string;
  /** Short human-readable description shown beside the command badge. */
  fallbackDescription?: string;
  /** Optional target context line attached below the command on send (e.g. "Member: Coder (coder)"). */
  contextLine?: string;
}

/** Resolves the default PA for embedded form/ask sessions without asking the user to pick one. */
export function resolveDefaultPa(agents: readonly AgentRow[] | undefined): AgentRow | undefined {
  const pas = (agents ?? []).filter((a) => a.role !== "worker" && a.archivedAt === null);
  const enabled = pas.filter((a) => a.enabled !== false);
  return (
    enabled.find((a) => a.id === "default") ??
    enabled[0] ??
    pas.find((a) => a.id === "default") ??
    pas[0]
  );
}

/** Resolves the composer's pinned slash-command chip against the active PA's installed skills. */
export function resolveRecommendedSkill(
  skills: readonly SkillCommand[],
  skillsLoaded: boolean,
  spec: DomainSkillSpec | undefined,
): RecommendedSkill | undefined {
  if (spec === undefined) return undefined;
  const hit =
    skills.find((s) => s.command === spec.fallbackCommand) ??
    skills.find((s) => s.command.toLowerCase().includes(spec.matchKeyword.toLowerCase()));
  if (hit) {
    return {
      command: hit.command,
      description: spec.fallbackDescription ?? hit.description,
      available: true,
      contextLine: spec.contextLine,
    };
  }
  return {
    command: spec.fallbackCommand,
    description: spec.fallbackDescription,
    available: !skillsLoaded,
    contextLine: spec.contextLine,
  };
}

/** Returns the default active PA without rendering any session or agent picker. */
export function useDefaultPa(): AgentRow | undefined {
  const { data: agents } = useAgentList();
  return useMemo(() => resolveDefaultPa(agents), [agents]);
}

interface PendingFirstSend {
  text: string;
  model?: ChatModelOverride;
  attachments?: readonly { type: "image"; mediaType: string; base64: string }[];
}

export interface PaSessionProps {
  /** Conversation provenance tag written on lazy creation (e.g. "editor:member", "ask"). */
  origin: string;
  /** Optional project bound to the lazily created conversation. */
  projectId?: string;
  /** Domain skill highlighted & auto-attached in the shared Composer by default. */
  skillSpec?: DomainSkillSpec;
  /** Optional prefilled draft put into the Composer while empty. */
  draft?: ComposerDraft;
  /** Optional action rendered on the right of the compact PA header bar (e.g. form brief button). */
  headerAction?: ReactNode;
  /** Heading shown in the empty state before the first message is sent. */
  emptyTitle?: ReactNode;
  /** Shown above the messages: e.g. ProposalCard or status notice. */
  children?: ReactNode;
  /** When this key changes (e.g. opening another resource), resets to a fresh lazy session. */
  sessionKey?: string;
}

/** Unified, isolated PA session embedded beside forms and Ask-PA sheets.
 *
 *  Design invariants:
 *  - Every open starts a fresh, isolated session — never mixes into the user's main chat history.
 *  - Lazy creation: the backend conversation is created only when the user sends the first message,
 *    preventing zero-message zombie sessions when someone opens and closes a form.
 *  - Zero PA/session picker clutter: auto-routes to the default enabled PA and displays its identity
 *    read-only alongside the shared Composer's default-visible slash command bar. */
export function PaSession({
  origin,
  projectId,
  skillSpec,
  draft,
  headerAction,
  emptyTitle,
  children,
  sessionKey,
}: PaSessionProps) {
  const defaultPa = useDefaultPa();
  const paId = defaultPa?.id ?? "";
  const skillsQuery = useQuery({ ...agentSkillCommandsQuery(paId), enabled: paId !== "" });
  const skills: readonly SkillCommand[] = skillsQuery.data ?? [];
  const recommendedSkill = useMemo(
    () => resolveRecommendedSkill(skills, skillsQuery.isSuccess, skillSpec),
    [skills, skillsQuery.isSuccess, skillSpec],
  );

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [pendingSend, setPendingSend] = useState<PendingFirstSend | null>(null);

  // Switching to a different resource (e.g. another workflow) resets cleanly to a fresh lazy session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset trigger on sessionKey
  useEffect(() => {
    setConversationId(null);
    setPendingSend(null);
    setStarting(false);
  }, [sessionKey]);

  const handleLazySend = useCallback(
    async (
      text: string,
      model?: ChatModelOverride,
      attachments?: readonly { type: "image"; mediaType: string; base64: string }[],
    ) => {
      if (!paId || starting) return;
      setStarting(true);
      try {
        const created = await api.createConversation({
          agentId: paId,
          origin,
          ...(projectId ? { projectId } : {}),
        });
        setPendingSend({ text, model, attachments });
        setConversationId(created.conversationId);
      } catch (err) {
        toast.error(t("Could not start a conversation"), {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setStarting(false);
      }
    },
    [paId, origin, projectId, starting],
  );

  const handleLazySlash = useCallback(
    (input: string) => {
      // Client-only commands (/clear, /stop, etc.) do nothing before a session exists;
      // skill commands (e.g. /member_manage ...) lazily create the session and send.
      if (findCommand(input)) return;
      void handleLazySend(input);
    },
    [handleLazySend],
  );

  const resetSession = useCallback(() => {
    setConversationId(null);
    setPendingSend(null);
  }, []);

  if (!defaultPa) {
    return (
      <div className="flex flex-1 flex-col items-start gap-3 p-6">
        <p className="text-sm text-(--mute)">
          {t("No PA to ask yet. Create a personal agent first.")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-(--canvas)">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-(--hairline) px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <RoleAvatar kind="pa" name={defaultPa.name} size="sm" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-xs font-medium leading-tight text-(--ink)">
              {defaultPa.name}
            </span>
            <span className="truncate text-[10px] leading-tight text-(--faint)">
              {t("Dedicated session")}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {headerAction}
          {conversationId !== null && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={resetSession}
              title={t("Start a fresh session")}
              aria-label={t("Start a fresh session")}
            >
              <RotateCcw className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {children}

      {conversationId === null ? (
        <ConversationDensityContext.Provider value="panel">
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
              <p className="text-sm font-medium text-(--ink)">
                {emptyTitle ?? t("Ask the PA to help here")}
              </p>
              <p className="mt-1.5 max-w-sm text-[11px] leading-relaxed text-(--mute)">
                {recommendedSkill
                  ? t(
                      "Starts an isolated session on your first message with {command} ready to guide creation or edits.",
                      { command: recommendedSkill.command },
                    )
                  : t(
                      "Starts an isolated session on your first message without mixing into your main chat history.",
                    )}
              </p>
            </div>
            <Composer
              conversationId=""
              onSend={(msg, model, attachments) => void handleLazySend(msg, model, attachments)}
              onSlashCommand={handleLazySlash}
              disabled={starting}
              skills={skills}
              recommendedSkill={recommendedSkill}
              showSkillChips
              draft={draft === undefined ? undefined : draft.text}
            />
          </div>
        </ConversationDensityContext.Provider>
      ) : (
        <MountedConversation
          conversationId={conversationId}
          paId={paId}
          draft={draft}
          emptyTitle={emptyTitle}
          skillSpec={skillSpec}
          pendingSend={pendingSend}
          onConsumedPending={() => setPendingSend(null)}
        />
      )}
    </div>
  );
}

interface MountedConversationProps {
  conversationId: string;
  paId: string;
  draft: ComposerDraft | undefined;
  emptyTitle?: ReactNode;
  skillSpec?: DomainSkillSpec;
  pendingSend: PendingFirstSend | null;
  onConsumedPending: () => void;
}

/** Owns the live subscription once the lazy session has been created on first message. */
function MountedConversation({
  conversationId,
  paId,
  draft,
  emptyTitle,
  skillSpec,
  pendingSend,
  onConsumedPending,
}: MountedConversationProps) {
  const conversation = useConversation(conversationId);
  const sentForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pendingSend) return;
    if (sentForRef.current === conversationId) return;
    sentForRef.current = conversationId;
    conversation.send(pendingSend.text, pendingSend.model, pendingSend.attachments);
    onConsumedPending();
  }, [conversationId, pendingSend, conversation, onConsumedPending]);

  const agentId = conversation.state.agent?.agentId ?? paId;
  const skillsQuery = useQuery({ ...agentSkillCommandsQuery(agentId), enabled: agentId !== "" });
  const skills: readonly SkillCommand[] = skillsQuery.data ?? [];
  const recommendedSkill = useMemo(
    () => resolveRecommendedSkill(skills, skillsQuery.isSuccess, skillSpec),
    [skills, skillsQuery.isSuccess, skillSpec],
  );

  return (
    <ConversationPanel
      conversationId={conversationId}
      conversation={conversation}
      skills={skills}
      recommendedSkill={recommendedSkill}
      showSkillChips
      draft={draft === undefined ? undefined : draft.text}
      marksSeen={false}
      density="panel"
      emptyTitle={emptyTitle}
    />
  );
}
