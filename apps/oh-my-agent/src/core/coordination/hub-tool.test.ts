import { afterEach, describe, expect, test } from "bun:test";
import { createHubTool, type HubToolDeps } from "./hub-tool.js";

function makeDeps(overrides: Partial<HubToolDeps> = {}): HubToolDeps {
  return {
    scope: "s1",
    list: (_scope) => [
      { id: "bg_1", kind: "bash", status: "completed", label: "echo hi", partialText: "hi" },
    ],
    get: (id) =>
      id === "bg_1"
        ? {
            id: "bg_1",
            kind: "bash",
            scope: "s1",
            label: "echo hi",
            startedAt: 0,
            status: "completed",
            finishedAt: 1,
            partialText: "hi",
            output: "hi",
            exitCode: 0,
            isError: false,
          }
        : undefined,
    wait: async () => ({ settled: [], timedOut: false }),
    stop: () => ({ ok: true }),
    steer: () => ({ ok: true }),
    ...overrides,
  };
}

describe("hub tool", () => {
  afterEach(() => {});

  test("jobs passes the scope through and returns rows", async () => {
    let seenScope = "";
    const [hub] = createHubTool(
      makeDeps({
        list: (scope) => {
          seenScope = scope;
          return [];
        },
      }),
    );
    const out = (await hub.execute({ op: "jobs" })) as { items: unknown[] };
    expect(seenScope).toBe("s1");
    expect(out.items).toEqual([]);
  });

  test("output validates id and returns the entry fields", async () => {
    const [hub] = createHubTool(makeDeps());
    const missing = (await hub.execute({ op: "output" })) as { ok: boolean };
    expect(missing.ok).toBe(false);
    const unknown = (await hub.execute({ op: "output", id: "nope" })) as { ok: boolean };
    expect(unknown.ok).toBe(false);
    const ok = (await hub.execute({ op: "output", id: "bg_1" })) as {
      id: string;
      status: string;
      output: string;
    };
    expect(ok.id).toBe("bg_1");
    expect(ok.status).toBe("completed");
    expect(ok.output).toBe("hi");
  });

  test("output caps oversized settled output to the tail and flags it", async () => {
    const big = `${"y".repeat(15_000)}END`;
    const [hub] = createHubTool(
      makeDeps({
        get: (id) =>
          id === "bg_1"
            ? {
                id: "bg_1",
                kind: "bash",
                scope: "s1",
                label: "big",
                startedAt: 0,
                status: "completed",
                finishedAt: 1,
                partialText: "",
                output: big,
                exitCode: 0,
                isError: false,
              }
            : undefined,
      }),
    );
    const out = (await hub.execute({ op: "output", id: "bg_1" })) as {
      output: string;
      outputTruncated?: boolean;
    };
    expect(out.output.length).toBe(10_000);
    expect(out.output.endsWith("END")).toBe(true);
    expect(out.outputTruncated).toBe(true);
  });

  test("jobs elides bodies already delivered, keeps the row (task/hub overlap)", async () => {
    // A blocking task batch returns its results inline; the same handles must
    // not show up AGAIN with bodies in the next hub snapshot (omp: an inline
    // spawn is a row without a body). Rows stay so the fan-out state is still
    // visible, and the first snapshot still carries its own bodies.
    const delivered = new Set<string>();
    const rows = [
      {
        id: "sub_a",
        kind: "subagent" as const,
        status: "completed" as const,
        label: "a",
        partialText: "A-BODY",
      },
      {
        id: "sub_b",
        kind: "subagent" as const,
        status: "completed" as const,
        label: "b",
        partialText: "B-BODY",
      },
    ];
    const [hub] = createHubTool(
      makeDeps({
        list: () => rows,
        acknowledge: (ids) => {
          for (const id of ids) delivered.add(id);
        },
        isDelivered: (id) => delivered.has(id),
      }),
    );
    const first = (await hub.execute({ op: "jobs" })) as { content: string };
    // First snapshot: both bodies are news.
    expect(first.content).toContain("A-BODY");
    expect(first.content).toContain("B-BODY");
    // Second snapshot: rows still listed, bodies elided (already delivered).
    const second = (await hub.execute({ op: "jobs" })) as { content: string };
    expect(second.content).toContain("sub_a");
    expect(second.content).toContain("sub_b");
    expect(second.content).not.toContain("A-BODY");
    expect(second.content).not.toContain("B-BODY");
  });

  test("output extracts a field by dot path (omp agent://id?q= without a URL scheme)", async () => {
    const entry = {
      id: "sub_1",
      kind: "subagent" as const,
      scope: "s1",
      label: "docs",
      startedAt: 0,
      status: "completed" as const,
      finishedAt: 1,
      partialText: "",
      result: {
        label: "docs",
        text: "raw prose",
        ok: true,
        output: { summary: "adapter layer", files: [{ path: "a.ts" }, { path: "b.ts" }] },
      },
    };
    const [hub] = createHubTool(makeDeps({ get: (id) => (id === "sub_1" ? entry : undefined) }));
    const top = (await hub.execute({ op: "output", id: "sub_1", path: "summary" })) as {
      value?: unknown;
    };
    expect(top.value).toBe("adapter layer");
    const nested = (await hub.execute({ op: "output", id: "sub_1", path: "files.1.path" })) as {
      value?: unknown;
    };
    expect(nested.value).toBe("b.ts");
    // A miss is a normal result, not a throw.
    const miss = (await hub.execute({ op: "output", id: "sub_1", path: "nope.deep" })) as {
      error?: string;
    };
    expect(miss.error).toContain("no field");
  });

  test("output caps an oversized subagent result.text like `output`", async () => {
    // A 67k-char subagent report was one hub output fetch; the model-facing
    // copy must respect the same budget as the bash/eval `output` field.
    const big = "z".repeat(40_000);
    const [hub] = createHubTool(
      makeDeps({
        get: (id) =>
          id === "sub_1"
            ? {
                id: "sub_1",
                kind: "subagent",
                scope: "s1",
                label: "docs",
                startedAt: 0,
                status: "completed",
                finishedAt: 1,
                partialText: "",
                result: { label: "docs", text: big, ok: true },
              }
            : undefined,
      }),
    );
    const out = (await hub.execute({ op: "output", id: "sub_1" })) as {
      result: { text: string; textTruncated?: boolean; textFullLength?: number };
    };
    expect(out.result.text.length).toBe(10_000);
    expect(out.result.textTruncated).toBe(true);
    expect(out.result.textFullLength).toBe(40_000);
  });

  test("jobs snapshot elides output past the budget and points at hub output", async () => {
    // A 6-agent fan-out used to put ~25k chars of fenced output into one
    // result; past the budget the body is elided per job.
    const big = "x".repeat(5_000);
    const rows = Array.from({ length: 6 }, (_, i) => ({
      id: `sub_${i}`,
      kind: "subagent" as const,
      status: "completed" as const,
      label: `agent-${i}`,
      partialText: big,
    }));
    const [hub] = createHubTool(makeDeps({ list: () => rows }));
    const out = (await hub.execute({ op: "jobs" })) as { content: string };
    // First body fits the budget; the rest are elided with a fetch hint.
    expect(out.content).toContain("x".repeat(1_000));
    expect(out.content).toContain('fetch with hub { "op": "output", "id": "sub_5" }');
    // Total stays well under the old 25k flood (6 × 5000).
    expect(out.content.length).toBeLessThan(12_000);
  });

  test("jobs/output/wait acknowledge settled rows (delivery suppression)", async () => {
    const acked: string[] = [];
    const [hub] = createHubTool(
      makeDeps({
        acknowledge: (ids) => acked.push(...ids),
        list: () => [
          { id: "bg_done", kind: "bash", status: "completed", label: "x", partialText: "" },
          { id: "bg_run", kind: "bash", status: "running", label: "y", partialText: "" },
        ],
        wait: async () => ({
          settled: [{ id: "w1", kind: "eval", status: "completed", label: "w", partialText: "" }],
          timedOut: false,
        }),
      }),
    );
    await hub.execute({ op: "jobs" });
    // Only the settled row is acked; running rows must keep their injection.
    expect(acked).toEqual(["bg_done"]);
    await hub.execute({ op: "output", id: "bg_1" });
    expect(acked).toEqual(["bg_done", "bg_1"]);
    await hub.execute({ op: "wait" });
    expect(acked).toEqual(["bg_done", "bg_1", "w1"]);
  });

  test("steer validates handle and prompt, stop delegates", async () => {
    const stops: string[] = [];
    const [hub] = createHubTool(
      makeDeps({
        stop: (id) => {
          stops.push(id);
          return { ok: true };
        },
      }),
    );
    const noPrompt = (await hub.execute({ op: "steer", id: "sub-1" })) as { ok: boolean };
    expect(noPrompt.ok).toBe(false);
    const ok = (await hub.execute({ op: "steer", id: "sub-1", prompt: "go on" })) as {
      ok: boolean;
    };
    expect(ok.ok).toBe(true);
    const stopped = (await hub.execute({ op: "stop", id: "bg_1" })) as { ok: boolean };
    expect(stopped.ok).toBe(true);
    expect(stops).toEqual(["bg_1"]);
  });

  test("wait passes ids and timeout through", async () => {
    const calls: Array<{ ids?: readonly string[]; timeoutMs: number }> = [];
    const [hub] = createHubTool(
      makeDeps({
        wait: async (o) => {
          calls.push({ ids: o.ids, timeoutMs: o.timeoutMs });
          return { settled: [], timedOut: true };
        },
      }),
    );
    const out = (await hub.execute({ op: "wait", ids: ["bg_1"], timeoutMs: 500 })) as {
      timedOut: boolean;
    };
    expect(out.timedOut).toBe(true);
    expect(calls[0]?.ids).toEqual(["bg_1"]);
    expect(calls[0]?.timeoutMs).toBe(500);
  });

  test("unknown op errors", async () => {
    const [hub] = createHubTool(makeDeps());
    const out = (await hub.execute({ op: "nope" })) as { ok: boolean };
    expect(out.ok).toBe(false);
  });

  test("wait streams live running snapshots through onOutput until settle", async () => {
    const running: Array<Record<string, unknown>> = [
      { id: "bg_9", kind: "bash", status: "running", label: "sleep", partialText: "" },
    ];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const snapshots: string[] = [];
    const [hub] = createHubTool(
      makeDeps({
        list: () => running as never,
        wait: async () => {
          await gate;
          return { settled: [], timedOut: false };
        },
      }),
    );
    const done = hub.execute({ op: "wait", timeoutMs: 5_000 }, undefined, {
      onOutput: (t) => snapshots.push(t),
    });
    // The 500ms interval must fire at least one live snapshot while the
    // wait is gated. Await the settle, not a fixed sleep.
    await Bun.sleep(700);
    expect(snapshots.some((t) => t.includes("waiting · 1 running (bg_9)"))).toBe(true);
    release?.();
    await done;
    const count = snapshots.length;
    await Bun.sleep(150);
    expect(snapshots.length).toBe(count);
  }, 10_000);
});
