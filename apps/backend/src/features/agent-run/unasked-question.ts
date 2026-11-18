/** ADR 0066 / the product walk (2026-11-18): a run can end with its answer
 *  asking the human something while NEVER opening an ask. The question is then
 *  invisible to the attention inbox, and nothing notices.
 *
 *  This is an OBSERVATION, not a gate: it records a fact so the real hit rate
 *  can be measured before anything is surfaced. A text heuristic will have
 *  false positives (code snippets, rhetorical questions, quoted material), and
 *  putting those into the inbox would train people to ignore the inbox. */

/** The last paragraph of an answer — where a closing question lives. */
export function lastParagraph(text: string): string {
  const parts = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  return parts.at(-1) ?? "";
}

/** Does the closing paragraph ask the human something?
 *
 *  Deliberately narrow: a question mark in the LAST paragraph. A question mark
 *  anywhere is mostly code, tables and quotes; a question mark at the end is
 *  how a person hands a decision back. */
export function endsWithQuestion(text: string): boolean {
  const tail = lastParagraph(text);
  if (tail === "") return false;
  // Ignore fenced code: a `?` inside a snippet is not a question to the human.
  const withoutCode = tail.replace(/```[\s\S]*?```/g, "");
  return /[?？]/.test(withoutCode);
}
