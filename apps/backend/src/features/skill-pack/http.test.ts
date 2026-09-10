import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, setupTestApp, type TestApp } from "../../testing/app-harness.js";

const SKILL = `---
name: greeter
description: Says hello to people
---
Findable token xyzzysnout.
`;

let harness: TestApp;

beforeAll(async () => {
  harness = await setupTestApp({ builtinSkills: { "greeter/SKILL.md": SKILL } });
});

afterAll(() => harness.dispose());

const BASE = "/api/skill-packs";

describe("skill-pack routes", () => {
  test("list shows the builtin pack ready", async () => {
    const res = await api(harness, "GET", BASE);
    expect(res.status).toBe(200);
    const packs = (await res.json()) as Array<{ id: string; status: string; sourceKind: string }>;
    const builtin = packs.find((p) => p.id === "builtin");
    expect(builtin).toBeDefined();
    expect(builtin!.status).toBe("ready");
    expect(builtin!.sourceKind).toBe("builtin");
  });

  test("lockfile and validate answer for the seeded pack", async () => {
    const lock = await api(harness, "GET", `${BASE}/lockfile`);
    expect(lock.status).toBe(200);
    expect(lock.headers.get("content-type")).toContain("application/json");

    const validate = await api(harness, "GET", `${BASE}/validate`);
    const { packs } = (await validate.json()) as { packs: Array<{ id: string }> };
    expect(packs.some((p) => p.id === "builtin")).toBe(true);
  });

  test("skills index reads the seeded SKILL.md", async () => {
    const res = await api(harness, "GET", `${BASE}/builtin/skills`);
    expect(res.status).toBe(200);
    const skills = (await res.json()) as Array<{ name: string; description: string; dir: string }>;
    const greeter = skills.find((s) => s.name === "greeter");
    expect(greeter).toBeDefined();
    expect(greeter!.description).toBe("Says hello to people");
    expect(greeter!.dir).toBe("greeter/SKILL.md");
  });

  test("files endpoint lists the pack dir and reads a file", async () => {
    const dir = await api(harness, "GET", `${BASE}/builtin/files`);
    const listing = (await dir.json()) as {
      type: string;
      entries: Array<{ name: string; type: string }>;
    };
    expect(listing.type).toBe("dir");
    expect(listing.entries.some((e) => e.name === "greeter" && e.type === "dir")).toBe(true);

    const file = await api(harness, "GET", `${BASE}/builtin/files?path=greeter/SKILL.md`);
    const body = (await file.json()) as { type: string; content: string };
    expect(body.type).toBe("file");
    expect(body.content).toContain("xyzzysnout");
  });

  test("files endpoint rejects traversal and unknown paths", async () => {
    const traversal = await api(
      harness,
      "GET",
      `${BASE}/builtin/files?path=${encodeURIComponent("../../etc/passwd")}`,
    );
    expect(traversal.status).toBe(400);
    expect(await traversal.json()).toEqual({ error: "cannot read pack files" });

    const missing = await api(harness, "GET", `${BASE}/builtin/files?path=no/such/file.md`);
    expect(missing.status).toBe(404);
  });

  test("search finds the seeded token", async () => {
    const res = await api(harness, "GET", `${BASE}/builtin/search?q=xyzzysnout`);
    const { results } = (await res.json()) as { results: Array<{ path: string; snippet: string }> };
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.path).toBe("greeter/SKILL.md");
  });

  test("search on a missing pack is a 404", async () => {
    const res = await api(harness, "GET", `${BASE}/ghost/search?q=x`);
    expect(res.status).toBe(404);
  });

  test("install-from-git registers a pending pack, then the installer fails it", async () => {
    const res = await api(harness, "POST", `${BASE}/git`, {
      name: "Remote Pack",
      description: "installed from a remote",
      // Local path: the clone fails fast and deterministically (no network).
      url: `${harness.dataDir}/no-such-source-repo.git`,
    });
    expect(res.status).toBe(202);
    const row = (await res.json()) as { id: string; status: string; sourceKind: string };
    expect(row.status).toBe("pending");
    expect(row.sourceKind).toBe("git");

    // The detached installer cannot clone the fake URL — the pack must land
    // in a terminal failed state instead of hanging pending forever.
    let status = "pending";
    for (let i = 0; i < 40 && status === "pending"; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const list = (await (await api(harness, "GET", BASE)).json()) as Array<{
        id: string;
        status: string;
      }>;
      status = list.find((p) => p.id === row.id)?.status ?? "missing";
    }
    expect(status).toBe("failed");
  }, 15000);

  test("delete of an unknown pack is a 404", async () => {
    const res = await api(harness, "DELETE", `${BASE}/no-such-pack`);
    expect(res.status).toBe(404);
  });
});
