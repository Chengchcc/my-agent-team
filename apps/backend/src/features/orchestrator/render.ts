/** Only {{var}} string interpolation. Missing vars fall back to empty string.
 *  Deliberately no conditionals, loops, or filters — no template DSL. */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}
