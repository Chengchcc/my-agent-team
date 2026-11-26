import type { RequirementRecord } from "./queries";

/** The text fields a person may write for a goal. They are the PATCH fields by name. */
export interface GoalFields {
  title: string;
  goal: string;
  background: string;
  constraints: string;
  expectedDeliverables: string;
  acceptanceCriteria: string;
}

const NO_FIELDS: GoalFields = {
  title: "",
  goal: "",
  background: "",
  constraints: "",
  expectedDeliverables: "",
  acceptanceCriteria: "",
};

export function fieldsOf(record: RequirementRecord | null): GoalFields {
  if (record === null) return { ...NO_FIELDS };
  return {
    title: record.title,
    goal: record.goal,
    background: record.background ?? "",
    constraints: record.constraints ?? "",
    expectedDeliverables: record.expectedDeliverables ?? "",
    acceptanceCriteria: record.acceptanceCriteria ?? "",
  };
}

export interface RequirementChange {
  title?: string;
  goal?: string;
  background?: string | null;
  constraints?: string | null;
  expectedDeliverables?: string | null;
  acceptanceCriteria?: string | null;
}

/** What differs from the saved goal. A required field (title, goal) that was emptied is not sent:
 *  the endpoint refuses it. An optional field that was emptied is sent as null, which clears it. */
export function changedFields(saved: RequirementRecord, fields: GoalFields): RequirementChange {
  const change: RequirementChange = {};
  if (fields.title !== "" && fields.title !== saved.title) change.title = fields.title;
  if (fields.goal !== "" && fields.goal !== saved.goal) change.goal = fields.goal;
  const pairs: Array<[keyof Omit<RequirementChange, "title" | "goal">, string | null]> = [
    ["background", saved.background ?? ""],
    ["constraints", saved.constraints ?? ""],
    ["expectedDeliverables", saved.expectedDeliverables ?? ""],
    ["acceptanceCriteria", saved.acceptanceCriteria ?? ""],
  ];
  for (const [key, before] of pairs) {
    const after = fields[key];
    if (after === before) continue;
    change[key] = after === "" ? null : after;
  }
  return change;
}

/** The brief a person writes for a goal that does not exist yet. It is a message, not a record. */
export interface GoalBrief {
  title: string;
  goal: string;
  constraints: string;
  acceptanceCriteria: string;
  background: string;
  /** A project id, or "" for none. */
  projectId: string;
}

export const EMPTY_BRIEF: GoalBrief = {
  title: "",
  goal: "",
  constraints: "",
  acceptanceCriteria: "",
  background: "",
  projectId: "",
};

export function briefIsEmpty(brief: GoalBrief): boolean {
  const words = [
    brief.title,
    brief.goal,
    brief.constraints,
    brief.acceptanceCriteria,
    brief.background,
  ];
  const typed = words.some((part) => part.trim() !== "");
  if (typed) return false;
  return brief.projectId === "";
}

/** The message that carries the brief to the PA. The goal is the only line it cannot do without;
 *  `lead` is the skill command to start with, or "" for none. */
export function briefMessage(brief: GoalBrief, projectName: string, lead: string): string {
  const lines: string[] = [];
  if (lead !== "") lines.push(lead);
  lines.push("Please track this as a requirement:");
  const put = (label: string, value: string): void => {
    const text = value.trim();
    if (text !== "") lines.push(`${label}: ${text}`);
  };
  put("Title", brief.title);
  put("Goal", brief.goal);
  put("Constraints", brief.constraints);
  put("Acceptance criteria", brief.acceptanceCriteria);
  put("Background", brief.background);
  put("Project", projectName === "" ? "none" : projectName);
  return lines.join("\n");
}
