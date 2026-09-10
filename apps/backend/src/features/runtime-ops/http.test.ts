import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, setupTestApp, type TestApp } from "../../testing/app-harness.js";

let harness: TestApp;

beforeAll(async () => {
  harness = await setupTestApp();
});

afterAll(() => harness.dispose());

describe("runtime-ops routes", () => {
  test("system-metrics reports live process numbers", async () => {
    const res = await api(harness, "GET", "/api/ops/system-metrics");
    expect(res.status).toBe(200);
    const m = (await res.json()) as {
      uptimeSec: number;
      rssMb: number;
      heapMb: number;
      dbSizeBytes: number | null;
      subprocesses: unknown[];
    };
    expect(m.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(m.rssMb).toBeGreaterThan(0);
    expect(m.heapMb).toBeGreaterThan(0);
    expect(Array.isArray(m.subprocesses)).toBe(true);
  });

  test("lark heartbeat ingest → surfaces → agent runtime projection", async () => {
    const beat = await api(harness, "POST", "/api/internal/surfaces/lark/heartbeat", {
      agentId: "a1",
      status: "healthy",
      payload: { msgs: 3, errors: 0 },
      lastError: "older failure kept for audit",
    });
    expect(beat.status).toBe(200);
    expect(await beat.json()).toEqual({ ok: true });

    const surfaces = await api(harness, "GET", "/api/ops/surfaces");
    const rows = (await surfaces.json()) as Array<{
      agentId: string;
      agentName: string;
      surface: string;
      status: string;
      lastError: string | null;
      counters: Record<string, number>;
    }>;
    const lark = rows.find((r) => r.agentId === "a1");
    expect(lark).toBeDefined();
    expect(lark!.surface).toBe("lark");
    expect(lark!.status).toBe("healthy");
    expect(lark!.lastError).toBe("older failure kept for audit");
    // Only numeric payload fields become counters.
    expect(lark!.counters).toEqual({ msgs: 3, errors: 0 });

    const runtime = await api(harness, "GET", "/api/ops/agents/a1/runtime");
    const rt = (await runtime.json()) as {
      agentId: string;
      agentName: string;
      surfaces: Record<string, { status: string; counters: Record<string, number> }>;
    };
    expect(rt.agentName).toBe("a1"); // falls back to agentId when unknown
    expect(rt.surfaces.lark!.status).toBe("healthy");
    expect(rt.surfaces.lark!.counters.msgs).toBe(3);
  });

  test("heartbeat without payload/lastError defaults cleanly", async () => {
    await api(harness, "POST", "/api/internal/surfaces/lark/heartbeat", {
      agentId: "a2",
      status: "down",
    });
    const runtime = await api(harness, "GET", "/api/ops/agents/a2/runtime");
    const rt = (await runtime.json()) as {
      surfaces: Record<
        string,
        { status: string; lastError: string | null; counters: Record<string, number> }
      >;
    };
    expect(rt.surfaces.lark!.status).toBe("down");
    expect(rt.surfaces.lark!.lastError).toBeNull();
    expect(rt.surfaces.lark!.counters).toEqual({});
  });

  test("unknown agent has an empty surface map", async () => {
    const res = await api(harness, "GET", "/api/ops/agents/ghost/runtime");
    expect(await res.json()).toEqual({ agentId: "ghost", agentName: "ghost", surfaces: {} });
  });

  test("telemetry summary and per-run events endpoints answer", async () => {
    const summary = await api(harness, "GET", "/api/telemetry/summary");
    expect(summary.status).toBe(200);
    const s = (await summary.json()) as { runs: number; since: number };
    expect(s.runs).toBe(0);
    expect(typeof s.since).toBe("number");

    const events = await api(harness, "GET", "/api/agent-runs/no-such-run/telemetry");
    expect(events.status).toBe(200);
    expect(await events.json()).toEqual({ events: [] });
  });
});
