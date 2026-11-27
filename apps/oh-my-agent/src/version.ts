import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Read oma's own package version without pulling in gateway/update modules.
 *  Works from both `src/` and compiled `dist/` (one level below package root). */
export function omaVersion(): string {
  const pkgPath = resolve(import.meta.dirname, "../package.json");
  const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
    const version: unknown = parsed.version;
    if (typeof version === "string") return version;
  }
  throw new Error(`no version found in ${pkgPath}`);
}
