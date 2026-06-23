import Handlebars from "handlebars";

/** M19: Handlebars-based prompt rendering — logic-less template engine with
 *  if/each helpers. Sandbox: noEscape, strict:false (missing→empty string),
 *  knownHelpersOnly (blocks unknown helpers). Compilation cached by template string. */

const hb = Handlebars.create();

const cache = new Map<string, Handlebars.TemplateDelegate>();

/** Context passed to Handlebars templates. Keys are the variable names
 *  available via {{key}} or {{#if key}} in templates. */
export type PromptVars = Record<string, unknown>;

/** Pre-compile validation — call at config-write time to reject bad templates
 *  before they reach runtime. Returns null on success, or the error message. */
export function validateTemplate(template: string): string | null {
  try {
    hb.compile(template, { noEscape: true, strict: false, knownHelpersOnly: true });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

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
  } catch (err) {
    // Bad template — log the error, fall back to raw template text, never crash the run
    console.error(
      `[renderPrompt] template render failed, returning raw template — error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return template;
  }
}
