/**
 * Who may drive this agent through Lark, and where.
 *
 * Modelled on openclaw-lark's inbound gates (`src/messaging/inbound/`) so the
 * two behave the same way, with one deliberate difference: our product is a
 * single-operator control plane (ADR 0026/0030), so the *default* for a group
 * nobody has configured is "not answered" rather than openclaw's "open".
 *
 * Three layers, in the order they run:
 *
 *   L1 group admission  — is this chat allowed to talk to the bot at all?
 *   L2 sender          — may this person drive the agent here?
 *   L3 mention         — was the bot actually addressed? (groups only)
 *
 * The allowlist vocabulary follows openclaw exactly: an EMPTY list denies
 * everybody, `"*"` grants everybody. Our previous rule was the opposite
 * (empty = everybody), which made "nobody" and "everybody" the same value.
 */

/** Group admission/sender policy. `disabled` = don't answer this chat. */
export type GroupPolicy = "open" | "allowlist" | "disabled";

export interface LarkGroupEntry {
  policy?: GroupPolicy;
  /** Only meaningful with `policy: "allowlist"`; falls back to the agent's
   *  top-level allowlist when absent. */
  allowedSenders?: readonly string[];
}

/** The part of the agent's lark config this module needs. */
export interface LarkAccessConfig {
  readonly allowedSenders: readonly string[];
  readonly groupPolicy?: GroupPolicy;
  readonly groups?: Readonly<Record<string, LarkGroupEntry>>;
  readonly requireMention?: boolean;
  readonly respondToMentionAll?: boolean;
}

const WILDCARD = "*";

/** Whether a sender is on an allowlist. Empty denies; `"*"` grants;
 *  comparison is case-insensitive (Lark ids are lower-case, but a
 *  hand-edited config is not guaranteed to be). */
export function matchesAllowlist(entries: readonly string[], senderId: string): boolean {
  if (entries.length === 0) return false;
  const wanted = senderId.trim().toLowerCase();
  return entries.some((entry) => {
    const e = entry.trim().toLowerCase();
    return e === WILDCARD || e === wanted;
  });
}

/** The policy for one chat: an explicit entry wins, otherwise the agent's
 *  default. Absent default = `disabled` (see the module comment). */
export function resolveGroupPolicy(
  cfg: LarkAccessConfig,
  chatId: string,
): { policy: GroupPolicy; allowFrom: readonly string[] } {
  const entry = cfg.groups?.[chatId];
  if (entry) {
    return {
      policy: entry.policy ?? "disabled",
      allowFrom: entry.allowedSenders ?? cfg.allowedSenders,
    };
  }
  return {
    policy: cfg.groupPolicy ?? "disabled",
    allowFrom: cfg.allowedSenders,
  };
}

/** What should happen to an admitted message.
 *
 *  Three outcomes, not two: a group message the bot was not addressed in is
 *  still worth recording (the agent gets context without answering), which is
 *  the same distinction openclaw draws between replying and writing a history
 *  entry. Collapsing it to allow/deny would make an unaddressed group message
 *  vanish from the conversation. */
export type InboundOutcome = "answer" | "observe" | "skip";

export interface InboundDecision {
  outcome: InboundOutcome;
  /** Stable, loggable reason. Never shown to the sender. */
  reason:
    | "dm_allowed"
    | "dm_denied"
    | "group_not_admitted"
    | "group_sender_denied"
    | "no_mention"
    | "allowed";
}

export interface InboundPolicyInput {
  cfg: LarkAccessConfig;
  chatId: string;
  /** "p2p" | "group" — anything that is not a group is treated as a DM. */
  chatType: string;
  senderId: string;
  /** The bot was really @-mentioned (structured mentions, not text). */
  mentionedBot: boolean;
  /** The message @-mentioned everyone in the chat. */
  mentionAll: boolean;
  /** This chat already has a conversation: the bot has been used here
   *  before, which is what keeps a pre-existing setup working after the
   *  group default flipped to "not answered". */
  chatInUse: boolean;
}

/** Run the layers for one inbound message. */
export function decideInbound(input: InboundPolicyInput): InboundDecision {
  const { cfg, chatId, senderId, chatInUse } = input;

  // ── DMs: one allowlist, no group concepts involved. A DM is always
  // addressed to the bot, so it never lands in "observe".
  if (input.chatType !== "group") {
    return matchesAllowlist(cfg.allowedSenders, senderId)
      ? { outcome: "answer", reason: "dm_allowed" }
      : { outcome: "skip", reason: "dm_denied" };
  }

  // ── L1 + L2: admission and sender, in one resolution ──
  const explicit = cfg.groups?.[chatId];
  if (explicit?.policy === "disabled") {
    // An explicit "no" beats the in-use carve-out: someone turned this chat
    // off on purpose.
    return { outcome: "skip", reason: "group_not_admitted" };
  }
  const { policy, allowFrom } = resolveGroupPolicy(cfg, chatId);

  if (policy === "disabled") {
    // No explicit entry and no open default: only a chat already in use is
    // admitted. That is the "a new group needs an explicit opt-in" rule, and
    // it is also what keeps existing installations answering where they
    // already were.
    if (!chatInUse) return { outcome: "skip", reason: "group_not_admitted" };
  } else if (policy === "allowlist") {
    if (!matchesAllowlist(allowFrom, senderId)) {
      return { outcome: "skip", reason: "group_sender_denied" };
    }
  }

  // ── L3: was the bot addressed? ──
  const mentionRequired = cfg.requireMention ?? true;
  if (mentionRequired && !input.mentionedBot) {
    // `@everyone` is not a request to this agent unless it is explicitly
    // opted in (openclaw's respondToMentionAll, also off by default).
    if (input.mentionAll && (cfg.respondToMentionAll ?? false)) {
      return { outcome: "answer", reason: "allowed" };
    }
    // Admitted but not addressed: record it, don't answer it.
    return { outcome: "observe", reason: "no_mention" };
  }

  return { outcome: "answer", reason: "allowed" };
}
