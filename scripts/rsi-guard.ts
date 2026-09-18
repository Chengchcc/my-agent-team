// RSI scope guard: fail when a diff touches paths outside the dogfood RSI
// allow-list (.oma/rsi/scope.json). Lives in scripts/ — itself deny-listed in
// scope.json, so the improving agent cannot weaken its own gate; CI re-runs it
// on every rsi-labeled PR (rsi-gate job in ci.yml).
//
// Usage:
//   bun scripts/rsi-guard.ts <rev-range>   (default: origin/main...HEAD)
//   bun scripts/rsi-guard.ts --self-test
import { readFileSync } from "node:fs";
import { $, Glob } from "bun";

const SCOPE_PATH = ".oma/rsi/scope.json";

interface RsiScope {
  allow: string[];
  deny: string[];
}

/** The manifest guards itself: loosening scope is a human-only change. */
const SELF_DENIED = [".oma/rsi/scope.json"];

/** Paths that trip a deny glob OR fall outside every allow glob. */
export function checkPaths(paths: readonly string[], scope: RsiScope): string[] {
  const denied = [...scope.deny, ...SELF_DENIED];
  return paths.filter(
    (path) =>
      denied.some((pat) => new Glob(pat).match(path)) ||
      !scope.allow.some((pat) => new Glob(pat).match(path)),
  );
}

function loadScope(): RsiScope {
  const parsed = JSON.parse(readFileSync(SCOPE_PATH, "utf8")) as RsiScope;
  if (!Array.isArray(parsed.allow) || !Array.isArray(parsed.deny)) {
    throw new Error(`${SCOPE_PATH}: "allow" and "deny" must be arrays`);
  }
  return parsed;
}

function selfTest(): void {
  const scope: RsiScope = {
    allow: [".oma/skills/**", ".oma/rsi/**"],
    deny: ["**/*.test.ts", "scripts/**"],
  };
  const ok = (label: string, cond: boolean) => {
    if (!cond) throw new Error(`self-test failed: ${label}`);
  };
  ok(
    "allow surface passes",
    checkPaths([".oma/skills/self-improve/SKILL.md", ".oma/rsi/lineage.jsonl"], scope).length === 0,
  );
  ok("outside allow is a violation", checkPaths(["apps/backend/src/main.ts"], scope).length === 1);
  ok("deny beats allow", checkPaths([".oma/skills/foo.test.ts"], scope).length === 1);
  // Even a scope that tries to allow everything cannot re-include itself.
  const greedy: RsiScope = { allow: ["**"], deny: [] };
  ok("scope.json is always denied", checkPaths([".oma/rsi/scope.json"], greedy).length === 1);
  // scripts/ is denied by scope.json's own deny list, which is protected
  // by the SELF_DENIED invariant above — no extra hardcoding needed.
  ok("scripts denied by real scope", checkPaths(["scripts/rsi-guard.ts"], scope).length === 1);
  console.log("rsi-guard self-test: ok");
}

if (import.meta.main) {
  if (process.argv[2] === "--self-test") {
    selfTest();
    process.exit(0);
  }
  const range = process.argv[2] ?? "origin/master...HEAD";
  const out = await $`git diff --name-only ${range}`.text();
  const paths = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const scope = loadScope();
  const violations = checkPaths(paths, scope);
  if (violations.length > 0) {
    console.error(`rsi-gate: ${violations.length} path(s) outside RSI scope:`);
    for (const v of violations) console.error(`  ${v}`);
    console.error(`(allow/deny lists live in ${SCOPE_PATH}; deny always wins)`);
    process.exit(1);
  }
  console.log(`rsi-gate: all ${paths.length} changed path(s) within scope`);
}
