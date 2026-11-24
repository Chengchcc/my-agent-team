# Locale dictionaries

Translation dictionaries for the UI (`lib/i18n.ts` is the seam; ADR 0079). This
directory is the ONLY place in apps/web/src that may contain non-English
text — `audit:ui` exempts it from the CJK gate.

- Keys are the English strings the components call `t()` with. A missing key
  renders English, so the two languages cannot drift apart silently.
- A dictionary is `export const zh: Record<string, string>` in `<lang>.ts`,
  registered once in `index.ts`.
- The person switches language in the operator menu (bottom of the sidebar);
  the choice is kept in `localStorage` (`ui.locale`), first visit follows the
  browser language.
- New UI copy: wrap it in `t()`, then add the key here. Unwrapped strings stay
  English in every language.
