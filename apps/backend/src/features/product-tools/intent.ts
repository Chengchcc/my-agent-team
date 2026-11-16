/** ADR 0054: what a dispatched task IS, expressed as orthogonal facets
 *  instead of one fat `kind` enum.
 *
 *  Why not an enum (evidence in the ADR): every new category re-draws the
 *  boundaries of the existing ones, so the set churns and the edge cases
 *  multiply. Adding a verb here changes nothing about the others; adding an
 *  object kind changes no verb's slots.
 *
 *  Division of labour matters more than the table:
 *  - the model produces FACETS (evidence about what the human wants),
 *  - this module turns facets into requirements and decisions (code).
 *
 *  That split is what keeps "an irreversible action needs a human in this
 *  turn" from being something a prompt can talk itself out of. */

export type Verb = "fix" | "build" | "review" | "investigate" | "write" | "operate" | "answer";

export type Deliverable = "answer" | "change" | "report" | "state-change";

export type ObjectKind = "code" | "doc" | "service" | "data" | "other";

export type Reversibility = "reversible" | "irreversible";

export const VERBS: readonly Verb[] = [
  "fix",
  "build",
  "review",
  "investigate",
  "write",
  "operate",
  "answer",
];

/** Which deliverables each verb can produce. A pair outside this table is a
 *  decomposition problem, not a task: "review AND fix" is two briefs. */
const ALLOWED_DELIVERABLES: Record<Verb, readonly Deliverable[]> = {
  fix: ["change", "report"],
  build: ["change"],
  review: ["report"],
  investigate: ["report"],
  write: ["report"],
  operate: ["state-change"],
  answer: ["answer"],
};

/** What the dispatcher must be able to state before the work leaves the front
 *  desk. `answer` needs nothing — it never leaves. */
const SLOTS_BY_VERB: Record<Verb, readonly string[]> = {
  fix: ["repro", "expected", "scope", "acceptance"],
  build: ["goal", "scope", "acceptance", "constraints"],
  review: ["target", "criteria"],
  investigate: ["question", "sources", "stop"],
  write: ["audience", "form", "source"],
  operate: ["environment", "action", "rollback"],
  answer: [],
};

const OBJECT_KINDS: readonly ObjectKind[] = ["code", "doc", "service", "data", "other"];

export interface Brief {
  readonly verb: Verb;
  readonly deliverable: Deliverable;
  /** What the work acts on, in the requester's words. */
  readonly object: string;
  readonly objectKind: ObjectKind;
  /** Ledger/memory references the front resolved for this task (ADR 0054 §recall). */
  readonly references: readonly string[];
  readonly reversibility: Reversibility;
  /** Filled slots, keyed by the names above. */
  readonly slots: Readonly<Record<string, string>>;
}

export type ParseResult =
  | { readonly ok: true; readonly brief: Brief }
  | { readonly ok: false; readonly reason: string };

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** Read the model's facets out of the tool arguments. Structural problems
 *  (unknown verb, impossible pair) are rejected here; missing SLOTS are a
 *  separate, softer rejection (`missingSlots`) so the message can name them. */
export function parseBrief(args: Record<string, unknown>): ParseResult {
  const verb = oneOf(args.verb, VERBS);
  if (verb === null) {
    return {
      ok: false,
      reason: `dispatch requires verb (one of ${VERBS.join(", ")}). If this is just a question, answer it instead of dispatching.`,
    };
  }
  const deliverable = oneOf(args.deliverable, ["answer", "change", "report", "state-change"]);
  if (deliverable === null) {
    return {
      ok: false,
      reason:
        "dispatch requires deliverable: answer | change | report | state-change (what the human gets back).",
    };
  }
  if (!ALLOWED_DELIVERABLES[verb].includes(deliverable)) {
    return {
      ok: false,
      reason: `a ${verb} produces ${ALLOWED_DELIVERABLES[verb].join(" or ")}, not "${deliverable}". Split the work: dispatch each part with its own verb.`,
    };
  }
  const objectKind = oneOf(args.objectKind, OBJECT_KINDS) ?? "other";
  const slots: Record<string, string> = {};
  if (typeof args.slots === "object" && args.slots !== null) {
    for (const [key, value] of Object.entries(args.slots as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim() !== "") slots[key] = value.trim();
    }
  }
  const references = Array.isArray(args.references)
    ? args.references.filter((r): r is string => typeof r === "string" && r.trim() !== "")
    : [];
  return {
    ok: true,
    brief: {
      verb,
      deliverable,
      object: typeof args.object === "string" ? args.object.trim() : "",
      objectKind,
      references,
      reversibility: args.reversibility === "reversible" ? "reversible" : "irreversible",
      slots,
    },
  };
}

/** The slots this brief still lacks, in the order the table declares them. */
export function missingSlots(brief: Brief): string[] {
  if (brief.deliverable === "answer") return [];
  return SLOTS_BY_VERB[brief.verb].filter((slot) => (brief.slots[slot] ?? "") === "");
}

/** The rejection message names every gap at once — a slot-filling loop that
 *  asks one field per turn is a documented failure mode, and the same applies
 *  to the model: one round trip, all the gaps. */
export function describeMissing(verb: Verb, missing: readonly string[]): string {
  const list = missing.join(", ");
  const guidance =
    verb === "operate"
      ? "Ask the human before dispatching: an irreversible action needs their confirmation in this turn."
      : "Do not invent them — call ask_question for all of them at once, then dispatch.";
  return `${verb} needs ${list}. ${guidance}`;
}

/** Irreversible work may only leave the desk on a human's authority from THIS
 *  turn (ADR 0049's basis). A rule or an assessment may notice it; only the
 *  person may authorise it. */
export function needsHumanAuthority(brief: Brief): boolean {
  return brief.verb === "operate" && brief.reversibility === "irreversible";
}

/** The framing the worker reads. It is a spec, not a paraphrase: the original
 *  words stay verbatim, the facets say what the front understood, and the
 *  slots say what "done" means. */
export function frameBrief(input: {
  fromAgentId: string;
  brief: Brief;
  instruction: string;
  note?: string;
}): string {
  const { fromAgentId, brief, instruction, note } = input;
  const lines = [
    `（由 ${fromAgentId} 派发的任务）`,
    `动作：${brief.verb} · 交付：${brief.deliverable} · 对象：${brief.objectKind}${
      brief.object === "" ? "" : `「${brief.object}」`
    }`,
  ];
  const slotNames = brief.deliverable === "answer" ? [] : SLOTS_BY_VERB[brief.verb];
  const slotLines = slotNames
    .map((name) => {
      const value = brief.slots[name];
      return value === undefined || value === "" ? null : `${name}：${value}`;
    })
    .filter((line): line is string => line !== null);
  if (slotLines.length > 0) lines.push("", ...slotLines);
  if (brief.verb === "operate") lines.push(`可逆性：${brief.reversibility}`);
  if (brief.references.length > 0) lines.push("", `引用：${brief.references.join("、")}`);
  if (note) lines.push("", `派单附注：${note}`);
  lines.push("", "请求者原文：", instruction);
  return lines.join("\n");
}
