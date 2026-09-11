/**
 * Workspace audit — the member set is declared in three places and they must
 * agree with what is on disk; each check below covers a drift that is silent
 * in the normal gates:
 *
 *  W1. package.json `workspaces` globs must cover every apps/*|packages/*
 *      package dir, must not match nothing, and must not be redundant (a
 *      pattern already fully covered by its siblings, e.g. `packages/sandbox`
 *      next to `packages/*`) — redundant patterns read as intent and mislead.
 *  W2. root tsconfig.json `references` must equal the dirs that have a
 *      tsconfig.json, both directions. CI never runs the root project
 *      (`turbo` typechecks each package with its own `tsc -p`), so a missing
 *      reference is invisible to `tsc -b` — it silently omits the project —
 *      and a dangling one only fails for whoever happens to run `tsc -b`
 *      locally.
 *  W3. every member must be named in AGENTS.md's "Package dependency graph".
 *      A package that exists but is invisible in the repo guide is how the
 *      guide rots (api-contract + adapter-mcp were missing 2026-09-12).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const failures: string[] = [];
const fail = (msg: string) => failures.push(msg);

const AREAS = ["apps", "packages"] as const;

/** dir → package name, for every direct child of apps/ or packages/ that
 *  declares a package.json (the set bun install treats as workspaces). */
const members = new Map<string, string>();
for (const area of AREAS) {
  for (const entry of readdirSync(join(ROOT, area), { withFileTypes: true })) {
    const manifest = join(ROOT, area, entry.name, "package.json");
    if (!entry.isDirectory() || !existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name: string };
    members.set(`${area}/${entry.name}`, name);
  }
}

// W1. workspaces globs.
const { workspaces = [] } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  workspaces?: string[];
};
/** The repo only declares single-segment patterns (`apps/*`, `packages/*`)
 *  plus exact paths; `*` never crosses a `/` — same shape npm/bun accept. */
const globToRegex = (glob: string) =>
  new RegExp(
    `^${glob
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]+")}$`,
  );
const matched = workspaces.map((glob) => {
  const re = globToRegex(glob);
  return new Set([...members.keys()].filter((dir) => re.test(dir)));
});
for (const dir of members.keys()) {
  if (!matched.some((set) => set.has(dir))) fail(`member not covered by "workspaces": ${dir}`);
}
matched.forEach((set, i) => {
  if (set.size === 0) {
    fail(`"workspaces" glob matches no package dir: ${workspaces[i]}`);
    return;
  }
  const others = new Set(matched.filter((_, j) => j !== i).flatMap((s) => [...s]));
  const own = [...set];
  if (own.every((dir) => others.has(dir))) {
    fail(
      `redundant "workspaces" glob (already covered by another pattern): ` +
        `"${workspaces[i]}" (e.g. ${own[0]})`,
    );
  }
});

// W2. root tsconfig references == TS projects on disk.
const tsconfigPath = join(ROOT, "tsconfig.json");
let references: string[] = [];
try {
  const parsed = JSON.parse(readFileSync(tsconfigPath, "utf8")) as {
    references?: { path: string }[];
  };
  references = (parsed.references ?? []).map((r) =>
    r.path.replace(/^\.\//, "").replace(/\/+$/, ""),
  );
} catch {
  fail("tsconfig.json is not parseable JSON");
}
const refSet = new Set(references);
for (const dir of members.keys()) {
  if (!existsSync(join(ROOT, dir, "tsconfig.json"))) continue;
  if (!refSet.has(dir)) fail(`tsconfig.json references missing project: ${dir}`);
}
for (const ref of refSet) {
  if (!members.has(ref)) fail(`tsconfig.json references a non-member project: ./${ref}`);
}

// W3. AGENTS.md package graph names every member.
const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
const graph = agents.split("**Package dependency graph")[1]?.split(/\n\*\*|\n## /)[0] ?? "";
if (graph === "") {
  fail("AGENTS.md has no 'Package dependency graph' section");
} else {
  const named = new Set([...graph.matchAll(/@chengchenccc\/([a-z0-9-]+)/g)].map((m) => m[1] ?? ""));
  for (const [dir, name] of members) {
    if (!named.has(name.replace("@chengchenccc/", ""))) {
      fail(`AGENTS.md package graph omits member: ${dir} (${name})`);
    }
  }
}

if (failures.length > 0) {
  console.error(`audit:workspace FAILED (${failures.length})`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `audit:workspace OK (${members.size} members: globs cover all, ` +
    `${references.length} tsconfig references in sync, all named in AGENTS.md)`,
);
