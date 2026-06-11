import { describe, expect, test } from "bun:test";
import { orchestrateReflection, type ReflectMeta } from "./reflect-orchestrator.js";

function harness(seed: Partial<ReflectMeta> & { runId: string }) {
  const forkLog: Array<{ runId: string; threadId: string; specJson: string }> = [];
  const runMeta = new Map<string, ReflectMeta>();
  runMeta.set(seed.runId, {
    isGenesis: seed.isGenesis ?? false,
    agentId: seed.agentId ?? "ag-x",
    agentMemberId: seed.agentMemberId ?? "mem-x1",
  });
  let n = 0;
  const deps = {
    runMeta,
    genId: () => `reflect-rid-${++n}`,
    buildSpecJson: async (
      _t: string,
      _i: string,
      o: { mode: "reflect"; runId: string; conversationId: string; senderMemberId: string },
    ) => JSON.stringify(o),
    fork: (runId: string, threadId: string, specJson: string) =>
      forkLog.push({ runId, threadId, specJson }),
  };
  return { forkLog, runMeta, deps };
}

describe("M14.3 P1-b: reflect orchestration", () => {
  // P1-b-1: 正常主 run → 起独立 reflect run（新 runId + reflect: 前缀 thread），并清 runMeta
  test("forks an independent reflect run for a normal main run", async () => {
    const { forkLog, runMeta, deps } = harness({ runId: "run-1" });
    const started = await orchestrateReflection("conv-a:mem-x1", "run-1", "conv-a", deps);
    expect(started).toBe(true);
    expect(forkLog).toHaveLength(1);
    expect(forkLog[0]!.runId).toBe("reflect-rid-1");             // 独立 runId（≠ 主 run-1）
    expect(forkLog[0]!.threadId).toBe("reflect:conv-a:mem-x1");  // reflect: 前缀隔离
    const spec = JSON.parse(forkLog[0]!.specJson);
    expect(spec.mode).toBe("reflect");
    expect(spec.senderMemberId).toBe("mem-x1");
    expect(runMeta.has("run-1")).toBe(false);                    // finally 清表
  });

  // P1-b-2: 防递归 —— reflect run 自身结束（reflect: 前缀）不再起反思
  test("does not recurse when the completed run is itself a reflect run", async () => {
    const { forkLog, deps } = harness({ runId: "reflect-rid-x" });
    const started = await orchestrateReflection(
      "reflect:conv-a:mem-x1",
      "reflect-rid-x",
      "conv-a",
      deps,
    );
    expect(started).toBe(false);
    expect(forkLog).toHaveLength(0); // 零 fork = 无限递归被斩断
  });

  // P1-b-3: genesis 跳过 + resume(无 meta)跳过 —— 触发条件门控
  test("skips reflection for genesis runs and for runs without meta (resume)", async () => {
    // genesis：meta 存在但 isGenesis=true
    const g = harness({ runId: "run-genesis", isGenesis: true });
    expect(
      await orchestrateReflection("conv-a:mem-x1", "run-genesis", "conv-a", g.deps),
    ).toBe(false);
    expect(g.forkLog).toHaveLength(0);
    expect(g.runMeta.has("run-genesis")).toBe(false); // genesis 也清表

    // resume：runMeta 里根本没有该 runId（forkRun 未登记）
    const r = harness({ runId: "other" });
    expect(
      await orchestrateReflection("conv-a:mem-x1", "run-resume-unknown", "conv-a", r.deps),
    ).toBe(false);
    expect(r.forkLog).toHaveLength(0);
  });
});
