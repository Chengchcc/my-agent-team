import Handlebars from "handlebars";

/** M19: Handlebars-based prompt rendering — logic-less template engine with
 *  if/each helpers. Sandbox: noEscape, strict:false (missing→empty string),
 *  knownHelpersOnly (blocks unknown helpers). Compilation cached by template string. */

const hb = Handlebars.create();

const cache = new Map<string, Handlebars.TemplateDelegate>();

/** Context passed to Handlebars templates. Keys are the variable names
 *  available via {{key}} or {{#if key}} in templates. */
export type PromptVars = Record<string, unknown>;

export function renderPrompt(template: string, vars: PromptVars): string {
  try {
    let tpl = cache.get(template);
    if (!tpl) {
      tpl = hb.compile(template, {
        noEscape: true,
        strict: false,
        knownHelpersOnly: true,
      });
      cache.set(template, tpl);
    }
    return tpl(vars);
  } catch {
    // Bad template — fall back to raw template text, never crash the run
    return template;
  }
}
