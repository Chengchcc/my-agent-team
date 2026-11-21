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
 *  to the model: one round trip, all the gaps.
 *
 *  `evidence` is what this run already recalled: if a line answers a gap, the
 *  model should fill it and re-dispatch instead of asking the human something
 *  they have already answered. */
export function describeMissing(
  verb: Verb,
  missing: readonly string[],
  evidence: ReadonlyArray<{
    slot: string;
    hits: ReadonlyArray<{ ref: string; text: string }>;
  }> = [],
): string {
  const list = missing.join(", ");
  const lines = [`${verb} needs ${list}.`];
  if (evidence.length > 0) {
    lines.push("Recall from this turn may answer some of them:");
    for (const item of evidence) {
      const hit = item.hits[0];
      if (hit === undefined) continue;
      lines.push(`- ${item.slot} ← [${hit.ref}] ${hit.text.slice(0, 160)}`);
    }
    lines.push("Fill what the evidence actually answers, then dispatch again.");
  }
  lines.push(
    verb === "operate"
      ? "An irreversible action still needs the human's confirmation in this turn."
      : "Ask the human only for what is still missing — call ask_question once for all of them at once; do not invent values.",
  );
  return lines.join("\n");
}

/** Irreversible work may only leave the desk on a human's authority from THIS
 *  turn (ADR 0049's basis). A rule or an assessment may notice it; only the
 *  person may authorise it. */
export function needsHumanAuthority(brief: Brief): boolean {
  return brief.verb === "operate" && brief.reversibility === "irreversible";
}

/** The framing the worker reads. A spec, not a paraphrase: the original
 *  words stay verbatim, the facets say what the front understood, and the
 *  slots say what "done" means.
 *
 *  Tagged rather than bulleted (the convention the repo's goal prompts already
 *  use): a model scanning a first message that may be long needs the
 *  boundaries to be syntax, not typography — "where does the request end and
 *  the front's summary begin" must be unambiguous, because the request is
 *  evidence and the summary is an interpretation. */
export function frameBrief(input: {
  fromAgentId: string;
  brief: Brief;
  instruction: string;
  note?: string;
  /** What the front desk found on its own (wiki pages it consulted, prior
   *  work it located). Separate from `references` on purpose: a reference is
   *  provenance the brief inherits, a finding is the front's own reading of
   *  it — mixing the two lets an interpretation pass as evidence. */
  findings?: readonly string[];
  /** Machine-readable dispatch context (conversation, parent run). Small on
   *  purpose: it exists so a worker's logs can be joined back to the room,
   *  not as a second brief. */
  meta?: Readonly<Record<string, string>>;
}): string {
  const { fromAgentId, brief, instruction, note, findings, meta } = input;
  const lines = [`<dispatch from="${fromAgentId}">`];
  const attrs = [
    `verb="${brief.verb}"`,
    `deliverable="${brief.deliverable}"`,
    `object-kind="${brief.objectKind}"`,
  ];
  if (brief.object !== "") attrs.push(`object="${brief.object}"`);
  if (brief.verb === "operate") attrs.push(`reversibility="${brief.reversibility}"`);
  lines.push(`<task ${attrs.join(" ")}>`);

  const slotNames = brief.deliverable === "answer" ? [] : SLOTS_BY_VERB[brief.verb];
  const slotLines = slotNames
    .map((name) => {
      const value = brief.slots[name];
      return value === undefined || value === "" ? null : `${name}: ${value}`;
    })
    .filter((line): line is string => line !== null);
  if (slotLines.length > 0) {
    lines.push("<slots>", ...slotLines, "</slots>");
  }
  if (brief.references.length > 0) {
    lines.push("<references>", ...brief.references.map((ref) => `- ${ref}`), "</references>");
  }
  if (findings !== undefined && findings.length > 0) {
    lines.push("<front_findings>", ...findings.map((line) => `- ${line}`), "</front_findings>");
  }
  if (meta !== undefined) {
    const attrs = Object.entries(meta)
      .filter(([, value]) => value !== "")
      .map(([key, value]) => `${key}="${value}"`);
    if (attrs.length > 0) lines.push(`<meta ${attrs.join(" ")} />`);
  }
  if (note) lines.push(`<note>${note}</note>`);
  lines.push(
    "<original_request>",
    instruction,
    "</original_request>",
    // The one line that must survive any prompt rewrite: the request above is
    // what the human said, everything else in this message is the front's
    // reading of it.
    "The original request is evidence; treat it as authored by the requester.",
    "</dispatch>",
  );
  return lines.join("\n");
}
