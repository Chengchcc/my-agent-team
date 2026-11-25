/** The conversation overview (`/chat`): grouping, filters and counts, as pure functions over rows
 *  that already exist. A conversation's only source fact is `origin` (user, fork, dispatch):
 *  whether it came from a Lark chat or a group is not recorded, so nothing here guesses it. */

export interface ConversationLike {
  conversationId: string;
  /** The room that dispatched this one; absent for a root conversation. */
  parentConversationId?: string | null;
  agentId?: string | null;
  origin: string;
  title?: string | null;
  lastMessagePreview?: string | null;
  projectId?: string | null;
  lastActivityAt?: number | null;
  createdAt: number;
}

export interface PaLike {
  id: string;
  name: string;
  role?: string | null;
  /** The member's Lark entry. It is configuration only: a name here says a bot is set up, not
   *  that it is connected. */
  lark?: { enabled?: boolean; botDisplayName?: string | null } | null;
}

export interface ProjectLike {
  projectId: string;
  name: string;
}

export type SourceFilter = "all" | "user" | "fork" | "dispatch";

/** The source filters in the order the page shows them. */
export const SOURCE_FILTERS: readonly SourceFilter[] = ["all", "user", "fork", "dispatch"];

export const ALL = "all";

/** The source filters' words. An origin outside these three is shown as it is stored. */
export const SOURCE_WORD: Readonly<Record<string, string>> = {
  user: "Started in a chat",
  fork: "Fork",
  dispatch: "Dispatched room",
};

export interface OverviewFilters {
  /** `all`, or one member's id. */
  pa: string;
  source: SourceFilter;
  query: string;
}

export interface OverviewConversation extends ConversationLike {
  /** The member whose group this conversation sits in: its own, or the root room's. */
  paId: string | null;
  projectName: string | null;
  /** How many of its items wait for the person: `attention.awaitingYou` rows of this room. */
  needYou: number;
  /** The title of the room that dispatched this one, for a dispatched room. */
  parentTitle: string | null;
}

export interface PaGroup {
  paId: string | null;
  conversations: OverviewConversation[];
}

export interface PaChip {
  pa: PaLike;
  conversations: number;
  /** The Lark bot's configured name, or null when no bot is enabled. */
  botName: string | null;
}

export interface SourceCounts {
  user: number;
  fork: number;
  dispatch: number;
}

export interface Overview {
  /** What the filters leave, one group per member, each newest activity first. */
  groups: PaGroup[];
  /** Every member that owns at least one conversation, whatever the filters: the chip row. */
  chips: PaChip[];
  /** Over every conversation, whatever the filters: the summary line. */
  counts: { total: number; roots: number; bySource: SourceCounts };
}

/** How far up a dispatch chain the root room is looked for. */
const MAX_CHAIN = 8;

function activityStamp(row: ConversationLike): number {
  if (row.lastActivityAt !== null && row.lastActivityAt !== undefined) return row.lastActivityAt;
  return row.createdAt;
}

/** A member's bot name as configured. No name comes back for a member whose Lark entry is off:
 *  the name is what a bot is called, and an entry that is off has no bot to call. */
export function botNameOf(pa: PaLike): string | null {
  const lark = pa.lark;
  if (lark === undefined || lark === null || lark.enabled !== true) return null;
  const name = lark.botDisplayName;
  if (name === undefined || name === null || name === "") return null;
  return name;
}

export function conversationOverview(input: {
  conversations: readonly ConversationLike[];
  pas: readonly PaLike[];
  projects: readonly ProjectLike[];
  awaiting: ReadonlyArray<{ conversationId: string }>;
  filters: OverviewFilters;
}): Overview {
  const paById = new Map(input.pas.map((pa) => [pa.id, pa] as const));
  const projectName = new Map(input.projects.map((project) => [project.projectId, project.name]));
  const byId = new Map(input.conversations.map((row) => [row.conversationId, row]));
  const needByRoom = new Map<string, number>();
  for (const row of input.awaiting) {
    const seen = needByRoom.get(row.conversationId) ?? 0;
    needByRoom.set(row.conversationId, seen + 1);
  }

  function paName(paId: string | null): string {
    if (paId === null) return "";
    const pa = paById.get(paId);
    return pa === undefined ? "" : pa.name;
  }

  /** The room a chain of dispatches starts from. A room whose parent is not listed (it was
   *  deleted) is its own root. */
  function rootOf(row: ConversationLike, depth: number): ConversationLike {
    const parentId = row.parentConversationId ?? null;
    if (parentId === null || depth >= MAX_CHAIN) return row;
    const parent = byId.get(parentId);
    if (parent === undefined) return row;
    return rootOf(parent, depth + 1);
  }

  const rows: OverviewConversation[] = input.conversations.map((conversation) => {
    const parentId = conversation.parentConversationId ?? null;
    const parent = parentId === null ? undefined : byId.get(parentId);
    const projectId = conversation.projectId ?? null;
    const project = projectId === null ? undefined : projectName.get(projectId);
    const parentTitle = parent === undefined ? "" : (parent.title ?? "");
    return {
      ...conversation,
      paId: rootOf(conversation, 0).agentId ?? null,
      projectName: project === undefined ? null : project,
      needYou: needByRoom.get(conversation.conversationId) ?? 0,
      parentTitle: parentTitle.trim() === "" ? null : parentTitle,
    };
  });

  const query = input.filters.query.trim().toLowerCase();
  const visible = rows.filter((row) => {
    if (input.filters.pa !== ALL && row.paId !== input.filters.pa) return false;
    if (input.filters.source !== ALL && row.origin !== input.filters.source) return false;
    if (query === "") return true;
    const title = row.title ?? "";
    const preview = row.lastMessagePreview ?? "";
    const project = row.projectName ?? "";
    const haystack = [title, preview, paName(row.paId), project].join(" ");
    return haystack.toLowerCase().includes(query);
  });

  const grouped = new Map<string | null, OverviewConversation[]>();
  for (const row of visible) {
    const group = grouped.get(row.paId);
    if (group === undefined) grouped.set(row.paId, [row]);
    else group.push(row);
  }
  const newestFirst = (a: OverviewConversation, b: OverviewConversation): number =>
    activityStamp(b) - activityStamp(a);
  const groups: PaGroup[] = [...grouped.entries()]
    .map(([paId, conversations]) => ({ paId, conversations: [...conversations].sort(newestFirst) }))
    .sort((a, b) => (paName(a.paId) || "\uffff").localeCompare(paName(b.paId) || "\uffff"));

  const owned = new Map<string | null, number>();
  for (const row of rows) {
    const seen = owned.get(row.paId) ?? 0;
    owned.set(row.paId, seen + 1);
  }
  const chips: PaChip[] = [];
  for (const [paId, count] of owned) {
    const pa = paId === null ? undefined : paById.get(paId);
    if (pa === undefined) continue;
    chips.push({ pa, conversations: count, botName: botNameOf(pa) });
  }
  chips.sort((a, b) => a.pa.name.localeCompare(b.pa.name));

  const bySource: SourceCounts = { user: 0, fork: 0, dispatch: 0 };
  let roots = 0;
  for (const row of rows) {
    if ((row.parentConversationId ?? null) === null) roots += 1;
    if (row.origin === "user" || row.origin === "fork" || row.origin === "dispatch") {
      bySource[row.origin] += 1;
    }
  }
  return { groups, chips, counts: { total: rows.length, roots, bySource } };
}
