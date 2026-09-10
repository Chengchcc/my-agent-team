import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, setupTestApp, type TestApp } from "../../testing/app-harness.js";

let harness: TestApp;

beforeAll(async () => {
  harness = await setupTestApp();
});

afterAll(() => harness.dispose());

const BASE = "/api/artifacts";

describe("artifact routes", () => {
  test("upload → 201 with an artifacts:// URL and normalized meta", async () => {
    const res = await api(harness, "POST", BASE, {
      folder: "runs/run-1",
      filename: "report.txt",
      content: "hello artifact",
      source: { runId: "run-1" },
    });
    expect(res.status).toBe(201);
    const meta = (await res.json()) as {
      url: string;
      folder: string;
      filename: string;
      size: number;
    };
    expect(meta.url).toBe("artifacts://runs/run-1/report.txt");
    expect(meta.size).toBe("hello artifact".length);
    expect(meta.folder).toBe("runs/run-1");
  });

  test("upload accepts base64 encoding", async () => {
    const res = await api(harness, "POST", BASE, {
      folder: "bin",
      filename: "blob.bin",
      content: Buffer.from([1, 2, 3]).toString("base64"),
      encoding: "base64",
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { encoding: string }).encoding).toBe("base64");
  });

  test("list returns uploads and honours the folder filter", async () => {
    const all = await api(harness, "GET", BASE);
    expect(all.status).toBe(200);
    const { artifacts } = (await all.json()) as { artifacts: Array<{ url: string }> };
    expect(artifacts.some((a) => a.url === "artifacts://runs/run-1/report.txt")).toBe(true);

    const filtered = await api(harness, "GET", `${BASE}?folder=bin`);
    const bin = (await filtered.json()) as { artifacts: Array<{ url: string }> };
    expect(bin.artifacts.map((a) => a.url)).toEqual(["artifacts://bin/blob.bin"]);
  });

  test("download round-trips content via ?url= and via /:url", async () => {
    const byQuery = await api(
      harness,
      "GET",
      `${BASE}/download?url=${encodeURIComponent("artifacts://runs/run-1/report.txt")}`,
    );
    expect(byQuery.status).toBe(200);
    expect(await byQuery.json()).toEqual({
      content: "hello artifact",
      encoding: "utf8",
      mimeType: "text/plain",
      size: "hello artifact".length,
    });

    const byPath = await api(
      harness,
      "GET",
      `${BASE}/${encodeURIComponent("artifacts://bin/blob.bin")}`,
    );
    expect(byPath.status).toBe(200);
    expect(((await byPath.json()) as { encoding: string }).encoding).toBe("base64");
  });

  test("download of a missing artifact is a 404 with the reason", async () => {
    const res = await api(
      harness,
      "GET",
      `${BASE}/download?url=${encodeURIComponent("artifacts://nope/missing.txt")}`,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "artifact not found: artifacts://nope/missing.txt" });
  });

  test("delete is idempotent via ?url= and via /:url", async () => {
    const viaQuery = await api(
      harness,
      "DELETE",
      `${BASE}/remove?url=${encodeURIComponent("artifacts://runs/run-1/report.txt")}`,
    );
    expect(viaQuery.status).toBe(200);
    expect(await viaQuery.json()).toEqual({ ok: true });

    const viaPath = await api(
      harness,
      "DELETE",
      `${BASE}/${encodeURIComponent("artifacts://bin/blob.bin")}`,
    );
    expect(await viaPath.json()).toEqual({ ok: true });

    // rmSync({ force: true }) — deleting an absent artifact stays ok:true.
    const again = await api(
      harness,
      "DELETE",
      `${BASE}/remove?url=${encodeURIComponent("artifacts://bin/blob.bin")}`,
    );
    expect(await again.json()).toEqual({ ok: true });
  });

  test("path traversal in folder/filename is a 400 at the boundary", async () => {
    const res = await api(harness, "POST", BASE, {
      folder: "../escape",
      filename: "evil.txt",
      content: "nope",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("unsafe artifact");
  });

  test("routes are auth-gated like every other feature route", async () => {
    const res = await harness.app.handle(new Request(`http://localhost${BASE}`));
    expect(res.status).toBe(401);
  });
});
