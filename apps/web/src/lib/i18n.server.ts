import { cookies } from "next/headers";
import { hasLocale, LOCALE_COOKIE, translate } from "./i18n";

/** Translate in a server component. Module state cannot carry the choice
 *  (one process renders every request), so the cookie is read per call. */
export async function serverLocale(): Promise<string> {
  const chosen = (await cookies()).get(LOCALE_COOKIE)?.value ?? "en";
  return hasLocale(chosen) ? chosen : "en";
}

export async function serverT(): Promise<(key: string) => string> {
  const lang = await serverLocale();
  return (key: string) => translate(lang, key);
}
