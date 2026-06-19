/** Only {{path}} string interpolation. Supports nested dot-path lookup
 *  (e.g. {{deliverables.plan.summary}}). Missing paths fall back to empty string.
 *  Non-string leaf values (intermediate objects) also fall back to empty string.
 *  Deliberately no conditionals, loops, or filters — no template DSL. */
export type PromptVars = { [k: string]: string | PromptVars };

export function renderPrompt(template: string, vars: PromptVars): string {
  return template.replace(/\{\{([\w.]+)\}\}/g, (_, path: string) => {
    const v = path.split(".").reduce<unknown>(
      (acc, seg) =>
        acc != null && typeof acc === "object" ? (acc as Record<string, unknown>)[seg] : undefined,
      vars,
    );
    return typeof v === "string" ? v : "";
  });
}
