/** i18n (UI review: "English baseline + i18n wiring"; ADR 0079).
 *
 *  English is the SOURCE, not the only language. `audit:ui` keeps the source
 *  free of CJK; translated text lives in `lib/locales/<lang>.ts` alone, which
 *  is what makes "the two languages cannot drift" checkable.
 *
 *  Wiring contract:
 *  - Keys ARE the English strings: `t("Today")` returns "Today" when no
 *    dictionary overrides it. Migration is incremental and safe — wrap a
 *    string in t() and it keeps rendering English until a locale
 *    dictionary lands.
 *  - Dictionaries live in `lib/locales/<lang>.ts` and are registered via
 *    registerLocale(). They are the ONLY place non-English UI text may
 *  appear (audit:ui exempts that directory).
 *  - setLocale() swaps the active dictionary at runtime. No reactive
 *    subscription yet — wire a React context when a real locale switcher
 *    lands (ponytail: the seam, not the framework). */

type Dictionary = Record<string, string>;

const locales = new Map<string, Dictionary>();
let current = "en";

/** Register a dictionary for a locale (later registrations win). */
export function registerLocale(lang: string, dict: Dictionary): void {
  locales.set(lang, { ...(locales.get(lang) ?? {}), ...dict });
}

/** Switch the active locale. Unknown keys fall back to the key itself. */
export function setLocale(lang: string): void {
  current = lang;
}

/** Translate a key. The key is the English source of truth; a missing
 *  entry renders the key unchanged, so untranslated strings stay English. */
export function t(key: string): string {
  return locales.get(current)?.[key] ?? key;
}

export const LOCALE_STORAGE_KEY = "ui.locale";

/** Every language that has a dictionary, in menu order. */
export const localeOptions: readonly { value: string; label: string }[] = [
  { value: "en", label: "English" },
  { value: "zh", label: "\u4e2d\u6587" },
];

export function currentLocale(): string {
  return current;
}

/** The language to start in: what the person chose, else their browser's
 *  language when it has a dictionary, else English. */
export function preferredLocale(): string {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored !== null && locales.has(stored)) return stored;
  const browser = navigator.language?.toLowerCase() ?? "";
  if (browser.startsWith("zh") && locales.has("zh")) return "zh";
  return "en";
}

/** Apply the stored choice. The dictionaries must be registered first
 *  (lib/locales/index.ts imports them). */
export function initLocale(): void {
  if (typeof window === "undefined") return;
  setLocale(preferredLocale());
}

/** Remember a choice. There is no reactive subscription (ponytail: the seam,
 *  not the framework) — the caller reloads, which is honest for a shell-wide
 *  setting and costs nothing to maintain. */
export function chooseLocale(lang: string): void {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, lang);
}
