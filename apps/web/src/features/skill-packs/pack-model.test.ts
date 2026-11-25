import { describe, expect, test } from "bun:test";
import {
  derivePackFacts,
  hiddenSegment,
  type PackCheck,
  packRevision,
  skillDirOf,
} from "./pack-model";

function check(overrides: Partial<PackCheck>): PackCheck {
  return { id: "p", ok: true, skills: 2, issues: [], ...overrides };
}

describe("derivePackFacts", () => {
  test("before any check the install record decides", () => {
    const ready = derivePackFacts({ id: "p", status: "ready" }, null);
    expect(ready.materialized).toBe("yes");
    expect(ready.materializedSource).toBe("install record");
    expect(ready.check).toBe("not checked");

    expect(derivePackFacts({ id: "p", status: "installing" }, null).materialized).toBe(
      "installing",
    );
    expect(derivePackFacts({ id: "p", status: "syncing" }, null).materialized).toBe("installing");
    expect(derivePackFacts({ id: "p", status: "failed" }, null).materialized).toBe("no");
  });

  test("the check wins over a ready record when the directory is gone", () => {
    const facts = derivePackFacts(
      { id: "p", status: "ready" },
      check({ ok: false, skills: 0, issues: ["materialized directory missing"] }),
    );
    expect(facts.materialized).toBe("no");
    expect(facts.materializedSource).toBe("check");
    expect(facts.check).toBe("failed");
    expect(facts.checkIssues).toEqual(["materialized directory missing"]);
  });

  test("files can be on disk while the check still fails on a SKILL.md", () => {
    const facts = derivePackFacts(
      { id: "p", status: "ready" },
      check({ ok: false, skills: 1, issues: ["SKILL.md missing frontmatter name: a/SKILL.md"] }),
    );
    expect(facts.materialized).toBe("yes");
    expect(facts.check).toBe("failed");
  });

  test("a passing check confirms both facts", () => {
    const facts = derivePackFacts({ id: "p", status: "ready" }, check({ ok: true, skills: 7 }));
    expect(facts.materialized).toBe("yes");
    expect(facts.check).toBe("passed");
    expect(facts.checkIssues).toEqual([]);
  });
});

describe("packRevision", () => {
  test("a commit is shortened to eight characters", () => {
    expect(packRevision("0123456789abcdef0123456789abcdef01234567")).toBe("01234567");
  });
  test("a server path or a missing value is not a revision", () => {
    expect(packRevision("/tmp/fe-stack/data/skill-packs/builtin")).toBeNull();
    expect(packRevision(null)).toBeNull();
    expect(packRevision(undefined)).toBeNull();
  });
});

describe("hiddenSegment", () => {
  test("dotfiles and .git paths are hidden at any depth", () => {
    expect(hiddenSegment(".git/config")).toBe(".git");
    expect(hiddenSegment("references/.env")).toBe(".env");
    expect(hiddenSegment("a/b/.github/workflows/x.yml")).toBe(".github");
  });
  test("ordinary paths pass", () => {
    expect(hiddenSegment("SKILL.md")).toBeNull();
    expect(hiddenSegment("scripts/check-source.js")).toBeNull();
    expect(hiddenSegment("")).toBeNull();
  });
});

describe("skillDirOf", () => {
  test("the SKILL.md path becomes its directory", () => {
    expect(skillDirOf("agent_doctor/SKILL.md")).toBe("agent_doctor");
    expect(skillDirOf("SKILL.md")).toBe("");
  });
});
