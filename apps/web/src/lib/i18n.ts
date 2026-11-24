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

import { zh } from "./locales/zh";

type Dictionary = Record<string, string>;

// Registered HERE, not in a client-only module: the server renders with the
// same table (a layout that read the cookie and asked hasLocale() got "no
// dictionary" because the client module never runs during the server pass —
// which quietly forced every page back to English, 2026-11-24).
const locales = new Map<string, Dictionary>([["zh", zh]]);
let current: string = "en";

/** Register a dictionary for a locale (later registrations win). Tests use it
 *  to stand up a throwaway language; production dictionaries live above. */
export function registerLocale(lang: string, dict: Dictionary): void {
  locales.set(lang, { ...(locales.get(lang) ?? {}), ...dict });
}

/** Switch the active locale. Unknown keys fall back to the key itself. */
export function setLocale(lang: string): void {
  current = lang;
}

/** Translate a key. The key is the English source of truth; a missing
 *  entry renders the key unchanged, so untranslated strings stay English. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const text = locales.get(current)?.[key] ?? key;
  if (vars === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}

/** The source language. It has no dictionary — every key IS its English text —
 *  so it must be recognised without one. Treating it as "unknown" made an
 *  explicit choice of English fall through to the browser's language (reported
 *  2026-11-24: choosing English did nothing on a Chinese-locale browser). */
const BASE_LOCALE = "en";

export const LOCALE_STORAGE_KEY = "ui.locale";
/** The choice that the SERVER can also read. A cookie (not localStorage) is
 *  what lets a server component render the chosen language, and lets the
 *  client's first render agree with the HTML it hydrates (ui review: switching
 *  only moved the shell, because SSR never saw the choice). */
export const LOCALE_COOKIE = "ui.locale";

/** Every language that has a dictionary, in menu order. */
export const localeOptions: readonly { value: string; label: string }[] = [
  { value: "en", label: "English" },
  { value: "zh", label: "\u4e2d\u6587" },
];

export function currentLocale(): string {
  return current;
}

/** A key as rendered in `lang`, without touching the active locale (server
 *  components use this: module state is shared by every concurrent request). */
export function translate(lang: string, key: string): string {
  return locales.get(lang)?.[key] ?? key;
}

export function hasLocale(lang: string): boolean {
  return lang === BASE_LOCALE || locales.has(lang);
}

function cookieLocale(): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === LOCALE_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** The language to start in: the cookie (what the server rendered), else what
 *  this browser chose before, else its own language, else English. */
export function preferredLocale(): string {
  if (typeof window === "undefined") return "en";
  const fromCookie = cookieLocale();
  if (fromCookie !== null && hasLocale(fromCookie)) return fromCookie;
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored !== null && hasLocale(stored)) return stored;
  const browser = navigator.language?.toLowerCase() ?? "";
  if (browser.startsWith("zh") && locales.has("zh")) return "zh";
  return "en";
}

/** Apply the stored choice. */
export function initLocale(): void {
  if (typeof window === "undefined") return;
  setLocale(preferredLocale());
}

// Import-time on the client only: the first render after a reload is already
// in the chosen language (the server rendered from the same cookie).
if (typeof window !== "undefined") initLocale();

/** Remember a choice for the server AND this browser. There is no reactive
 *  subscription (ponytail: the seam, not the framework) — the caller reloads,
 *  which is honest for a shell-wide setting. */
export function chooseLocale(lang: string): void {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, lang);
  // biome-ignore lint/suspicious/noDocumentCookie: the server reads this raw
  // cookie to render the chosen language; localStorage cannot do that.
  document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(lang)}; path=/; max-age=31536000; SameSite=Lax`;
}
