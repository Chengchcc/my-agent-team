import { describe, expect, test } from "bun:test";
import {
  ALL,
  botNameOf,
  type ConversationLike,
  conversationOverview,
  type OverviewFilters,
  type PaLike,
} from "./overview";

const PA_ONE: PaLike = {
  id: "pa-one",
  name: "Personal Agent",
  lark: { enabled: true, botDisplayName: "Dev Bot" },
};

const PA_TWO: PaLike = { id: "pa-two", name: "Research PA", lark: { enabled: false } };

const WORKER: PaLike = { id: "coder", name: "Coder" };

function roomOf(fields: {
  id: string;
  agentId: string | null;
  at: number;
  parent?: string;
  origin?: string;
  title?: string;
  projectId?: string;
}): ConversationLike {
  const conversation: ConversationLike = {
    conversationId: fields.id,
    parentConversationId: fields.parent === undefined ? null : fields.parent,
    agentId: fields.agentId,
    origin: fields.origin === undefined ? "user" : fields.origin,
    title: fields.title === undefined ? null : fields.title,
    projectId: fields.projectId === undefined ? null : fields.projectId,
    lastActivityAt: fields.at,
    createdAt: fields.at - 1_000,
  };
  return conversation;
}

const ROOMS: ConversationLike[] = [
  roomOf({
    id: "readme",
    agentId: "pa-one",
    at: 500,
    title: "README first screen",
    projectId: "p1",
  }),
  // A worker's room that the first PA dispatched: it sits in that PA's group.
  roomOf({ id: "coder-room", agentId: "coder", at: 900, parent: "readme", origin: "dispatch" }),
  // A second dispatch level: still the first PA's group.
  roomOf({
    id: "review-room",
    agentId: "coder",
    at: 950,
    parent: "coder-room",
    origin: "dispatch",
  }),
  roomOf({ id: "fork", agentId: "pa-one", at: 400, origin: "fork", title: "Forked notes" }),
  roomOf({ id: "research", agentId: "pa-two", at: 700, title: "Multi-agent notes" }),
  // Its parent is gone from the list: the room is its own root and keeps its own member.
  roomOf({ id: "orphan", agentId: "coder", at: 800, parent: "deleted", origin: "dispatch" }),
];

const INPUT = {
  conversations: ROOMS,
  pas: [PA_ONE, PA_TWO, WORKER],
  projects: [{ projectId: "p1", name: "Agent Workspace" }],
  awaiting: [
    { conversationId: "readme" },
    { conversationId: "readme" },
    { conversationId: "coder-room" },
  ],
};

const NO_FILTERS: OverviewFilters = { pa: ALL, source: ALL, query: "" };

function idsOf(filters: OverviewFilters): string[] {
  return conversationOverview({ ...INPUT, filters }).groups.flatMap((group) =>
    group.conversations.map((conversation) => conversation.conversationId),
  );
}

describe("conversationOverview · grouping", () => {
  test("groups by the member that owns the conversation, named members before unnamed", () => {
    const { groups } = conversationOverview({ ...INPUT, filters: NO_FILTERS });
    expect(groups.map((group) => group.paId)).toEqual(["coder", "pa-one", "pa-two"]);
    expect(idsOf(NO_FILTERS)).toEqual([
      "orphan",
      "review-room",
      "coder-room",
      "readme",
      "fork",
      "research",
    ]);
  });

  test("a dispatched room belongs to the PA that dispatched it, however deep", () => {
    const { groups } = conversationOverview({ ...INPUT, filters: NO_FILTERS });
    const mine = groups.find((group) => group.paId === "pa-one");
    expect(mine?.conversations.map((conversation) => conversation.conversationId)).toEqual([
      "review-room",
      "coder-room",
      "readme",
      "fork",
    ]);
  });

  test("the newest activity comes first inside a group", () => {
    const { groups } = conversationOverview({ ...INPUT, filters: NO_FILTERS });
    const coder = groups.find((group) => group.paId === "coder");
    const newest = coder === undefined ? undefined : coder.conversations[0];
    expect(newest?.conversationId).toBe("orphan");
  });

  test("a row carries the title of the room that dispatched it and its project's name", () => {
    const { groups } = conversationOverview({ ...INPUT, filters: NO_FILTERS });
    const rows = groups.flatMap((group) => group.conversations);
    const coderRoom = rows.find((row) => row.conversationId === "coder-room");
    const reviewRoom = rows.find((row) => row.conversationId === "review-room");
    const readme = rows.find((row) => row.conversationId === "readme");
    expect([
      coderRoom?.parentTitle,
      reviewRoom?.parentTitle,
      readme?.parentTitle,
      readme?.projectName,
    ]).toEqual(["README first screen", null, null, "Agent Workspace"]);
  });
});

describe("conversationOverview · need-you counts", () => {
  test("counts the items that wait for the person per conversation", () => {
    const { groups } = conversationOverview({ ...INPUT, filters: NO_FILTERS });
    const need = new Map(
      groups.flatMap((group) =>
        group.conversations.map((conversation) => [
          conversation.conversationId,
          conversation.needYou,
        ]),
      ),
    );
    expect(need.get("readme")).toBe(2);
    expect(need.get("coder-room")).toBe(1);
    expect(need.get("fork")).toBe(0);
  });
});

describe("conversationOverview · filters", () => {
  test("the member filter leaves only that member's group", () => {
    expect(idsOf({ ...NO_FILTERS, pa: "pa-two" })).toEqual(["research"]);
    expect(
      conversationOverview({ ...INPUT, filters: { ...NO_FILTERS, pa: "pa-two" } }).groups,
    ).toHaveLength(1);
  });

  test("the source filter reads origin only", () => {
    expect(idsOf({ ...NO_FILTERS, source: "fork" })).toEqual(["fork"]);
    expect(idsOf({ ...NO_FILTERS, source: "dispatch" })).toEqual([
      "orphan",
      "review-room",
      "coder-room",
    ]);
    expect(idsOf({ ...NO_FILTERS, source: "user" })).toEqual(["readme", "research"]);
  });

  test("the search matches a title, a member's name and a project name, ignoring case", () => {
    expect(idsOf({ ...NO_FILTERS, query: " first " })).toEqual(["readme"]);
    expect(idsOf({ ...NO_FILTERS, query: "RESEARCH" })).toEqual(["research"]);
    expect(idsOf({ ...NO_FILTERS, query: "workspace" })).toEqual(["readme"]);
  });

  test("a search that matches nothing leaves no groups", () => {
    const { groups } = conversationOverview({ ...INPUT, filters: { ...NO_FILTERS, query: "zzz" } });
    expect(groups).toEqual([]);
  });
});

describe("conversationOverview · chips and summary", () => {
  test("the chip row lists every member with a conversation, by name, with its count and bot", () => {
    const { chips } = conversationOverview({ ...INPUT, filters: { ...NO_FILTERS, pa: "pa-two" } });
    expect(chips.map((chip) => [chip.pa.id, chip.conversations, chip.botName])).toEqual([
      ["coder", 1, null],
      ["pa-one", 4, "Dev Bot"],
      ["pa-two", 1, null],
    ]);
  });

  test("the summary counts every conversation, whatever the filters", () => {
    const { counts } = conversationOverview({ ...INPUT, filters: { ...NO_FILTERS, pa: "pa-two" } });
    expect(counts).toEqual({ total: 6, roots: 3, bySource: { user: 2, fork: 1, dispatch: 3 } });
  });

  test("a bot name is read only off an enabled Lark entry", () => {
    expect(botNameOf(PA_ONE)).toBe("Dev Bot");
    expect(botNameOf(PA_TWO)).toBeNull();
    expect(botNameOf(WORKER)).toBeNull();
    expect(
      botNameOf({ id: "x", name: "X", lark: { enabled: true, botDisplayName: "" } }),
    ).toBeNull();
  });
});
