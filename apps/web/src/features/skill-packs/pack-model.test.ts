import { describe, expect, test } from "bun:test";
import { visibleHits } from "@/components/pack-file-utils";
import {
  derivePackFacts,
  hiddenSegment,
  type PackCheck,
  packIdsAfter,
  packRevision,
  skillDirOf,
  upstreamChanged,
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

describe("hiddenSegment guards what is requested and listed", () => {
  test("a dot segment anywhere makes the path hidden", () => {
    expect(hiddenSegment(".git/config")).toBe(".git");
    expect(hiddenSegment("skills/x/.env")).toBe(".env");
    expect(hiddenSegment("skills/.hidden/SKILL.md")).toBe(".hidden");
    expect(hiddenSegment("skills/references/notes.md")).toBeNull();
  });

  test("every hidden path is dropped, visible ones kept", () => {
    const hits = [
      { path: "a/SKILL.md", line: 1, snippet: "s" },
      { path: ".git/HEAD", line: 2, snippet: "s" },
      { path: "a/.netrc", line: 3, snippet: "s" },
    ];
    expect(visibleHits(hits).map((hit) => hit.path)).toEqual(["a/SKILL.md"]);
    expect(visibleHits(undefined)).toEqual([]);
  });
});

describe("packIdsAfter", () => {
  test("adds, removes, or reports no change", () => {
    expect(packIdsAfter(["a"], "b", true)).toEqual(["a", "b"]);
    expect(packIdsAfter(["a", "b"], "a", false)).toEqual(["b"]);
    expect(packIdsAfter(["a"], "a", true)).toBeNull();
    expect(packIdsAfter(["a"], "b", false)).toBeNull();
  });
});

describe("upstreamChanged", () => {
  class RequestError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }

  test("reads the 409 body and nothing else", () => {
    const body = JSON.stringify({
      error: "moved",
      code: "upstream_changed",
      from: "aaa",
      to: "bbb",
    });
    expect(upstreamChanged(new RequestError(409, body))).toEqual({ from: "aaa", to: "bbb" });
    expect(upstreamChanged(new RequestError(500, body))).toBeNull();
    expect(upstreamChanged(new RequestError(409, "not json"))).toBeNull();
    expect(upstreamChanged(new RequestError(409, '{"code":"other"}'))).toBeNull();
    expect(upstreamChanged("x")).toBeNull();
  });
});
