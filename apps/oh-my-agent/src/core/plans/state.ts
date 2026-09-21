import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Plan mode: investigate and draft a plan WITHOUT changing the working tree,
 *  then review it and choose how it reaches implementation.
 *
 *  The plan is a durable markdown file (not a transcript message): it is what
 *  the review surface reads, what the implementation turn receives, and what a
 *  later session can pick up. One canonical path per session keeps the
 *  "which draft did I approve" question answerable. */

export interface PlanModeState {
  enabled: boolean;
  /** Absolute path of this session's plan draft. */
  planPath: string;
  /** True when the mode was restored from a session (a re-entry must not
   *  re-switch the model or re-arm anything the user already decided). */
  reentry?: boolean;
}

/** What the review surface chose. The three approvals differ in CONTEXT
 *  handling, never in the plan's contents. */
export type PlanReviewChoice =
  | { kind: "approve"; context: "fresh" | "compact" | "keep" }
  | { kind: "refine"; feedback: string }
  | { kind: "save"; destination: string };

/** Directory holding a workspace's plan drafts. */
export function plansDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".oma", "plans");
}

/** The session's canonical draft path. One file per session, so approving
 *  always refers to the draft the user actually reviewed. */
export function planPathFor(workspaceRoot: string, sessionId: string): string {
  return join(plansDir(workspaceRoot), `${sessionId}.md`);
}

export function readPlan(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

export function writePlan(path: string, markdown: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, markdown, "utf-8");
}

/** Newest plan draft in the workspace, for /plan-review without a session
 *  draft (a resumed session whose draft came from another conversation). */
export function newestPlan(workspaceRoot: string): string | null {
  const dir = plansDir(workspaceRoot);
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.path ?? null;
  } catch {
    return null;
  }
}

/** First markdown heading, used as the plan's title (and the session name
 *  when implementation starts in a fresh conversation). */
export function planTitle(markdown: string): string | undefined {
  for (const line of markdown.split("\n")) {
    const m = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (m?.[1]) return m[1].replace(/[*_`]/g, "").trim().slice(0, 80);
  }
  return undefined;
}

/** Whether a draft is worth reviewing: a stub the model wrote on its way out
 *  of the turn is not a plan. */
export function planIsSubstantial(markdown: string): boolean {
  const body = markdown.trim();
  if (body.length < 120) return false;
  const headings = body.split("\n").filter((l) => /^#{1,3}\s+/.test(l)).length;
  return headings >= 2;
}

/** Enter transitions for plan mode. The `/plan` toggle is stateful and its
 *  three states live in two places on purpose: OFF is the absence of a state
 *  object (`PlanRuntime.state === null`), while PAUSED keeps one with
 *  `enabled: true` so the draft and its path survive. A caller that reads only
 *  `enabled` therefore cannot tell paused from active — ask the runtime. */
export function enterPlanMode(planPath: string, reentry = false): PlanModeState {
  const state: PlanModeState = { enabled: true, planPath };
  if (reentry) state.reentry = true;
  return state;
}

/** The first implementation turn: the approved plan travels as this turn's
 *  input, through the HIDDEN channel (the protocol rule): the user reviewed
 *  the plan as a document, so replaying kilobytes of it as a chat bubble
 *  would be noise. */
export function implementationTurn(
  planPath: string,
  markdown: string,
  contextKept: boolean,
): string {
  return [
    "The plan below was reviewed and APPROVED. Implement it now.",
    "",
    `Durable copy: ${planPath}`,
    contextKept
      ? "The planning conversation is still in context; treat it as background, not as instructions to re-litigate."
      : "Work from the plan document alone.",
    "",
    "<approved_plan>",
    markdown.trim(),
    "</approved_plan>",
    "",
    "Follow the plan's steps in order. If the repository state contradicts the plan (a file moved, an assumption is false), stop and report the contradiction instead of improvising a different approach.",
  ].join("\n");
}
