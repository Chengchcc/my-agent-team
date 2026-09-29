/** 上游一致性向量（ADR 0040 决策二的升级闸门）。
 *
 *  数据来源：github.com/microsoft/agent-host-protocol 的 `types/test-cases/reducers/`，
 *  取自 tag `v0.9.0`——**必须与 package.json 里钉的依赖同源**：仓库 HEAD 的向量比
 *  0.9.0 多十来条，拿它跑会在「上游自己都没实现的动作」上假红（实测过）。只纳入我们
 *  真正服务的三类频道：root / session / chat，共 218 条；上游另有 terminal、changeset、
 *  annotations、automation 等 54 条，属于我们不提供的频道，故未纳入。
 *
 *  每条向量都走我们自己的服务端：派发它的动作序列，再用一条新连接订阅，拿到的快照
 *  必须等于向量给出的期望状态。这样测的是**我们的**播种、reduce、快照三件事，而不是
 *  上游 reducer 自身（那部分由上游自己的测试保证）。 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StateAction, URI } from "@microsoft/agent-host-protocol";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import { AhpClient, InMemoryTransport } from "@microsoft/agent-host-protocol/client";
import { AHP_ROOT, type AhpServer, type AhpStateSource, createAhpServer } from "./protocol.js";

const CONFORMANCE_DIR = join(import.meta.dir, "conformance");

interface Vector {
  readonly description: string;
  readonly reducer: "root" | "session" | "chat";
  readonly initial: unknown;
  readonly actions: readonly unknown[];
  readonly expected: unknown;
}

/** 上游向量把「无值」序列化成显式 `null`，reducer 的内存结果里是缺键。两者同义，
 *  比对前统一成「丢 null 属性」（数组里的 null 是有意义的，保留）。 */
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (inner === null || inner === undefined) continue;
      out[key] = stripNulls(inner);
    }
    return out;
  }
  return value;
}

function channelOf(reducer: Vector["reducer"]): URI {
  if (reducer === "root") return AHP_ROOT;
  if (reducer === "session") return "ahp-session:/conformance" as URI;
  return "ahp-chat:/conformance" as URI;
}

/** 状态源只回答这一条向量的初始状态；其余频道不参与。 */
function sourceOf(initial: unknown): AhpStateSource {
  return {
    root: async () => initial as never,
    session: async () => initial as never,
    chat: async () => initial as never,
  };
}

async function readBack(server: AhpServer, uri: URI): Promise<unknown> {
  const [clientSide, serverSide] = InMemoryTransport.pair();
  const connection = server.createConnection((frame) => {
    void serverSide.send(frame);
  });
  void (async () => {
    for (;;) {
      const frame = await serverSide.recv();
      if (frame === null) break;
      connection.handle(
        frame.kind === "text"
          ? frame.text
          : frame.kind === "binary"
            ? new TextDecoder().decode(frame.data)
            : JSON.stringify(frame.message),
      );
    }
  })();
  const client = new AhpClient(clientSide);
  client.connect();
  const init = await client.initialize({
    clientId: "conformance",
    protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    initialSubscriptions: [uri],
  });
  await client.shutdown();
  return init.snapshots.find((snapshot) => snapshot.resource === uri)?.state;
}

describe("upstream conformance vectors", () => {
  test("every root/session/chat reducer vector replays through our server", async () => {
    const files = readdirSync(CONFORMANCE_DIR)
      .filter((name) => name.endsWith(".json"))
      .sort();
    // 数量写死：向量被误删或少拷时，闸门要红，而不是悄悄少跑几条。
    expect(files.length).toBe(218);

    const failures: string[] = [];
    for (const file of files) {
      const vector = JSON.parse(readFileSync(join(CONFORMANCE_DIR, file), "utf8")) as Vector;
      const uri = channelOf(vector.reducer);
      const server = createAhpServer({
        source: sourceOf(vector.initial),
        commands: { submit: () => undefined },
      });
      try {
        for (const action of vector.actions) {
          await server.dispatch(uri, action as StateAction);
        }
        const state = await readBack(server, uri);
        if (!Bun.deepEquals(stripNulls(state), stripNulls(vector.expected))) {
          failures.push(
            `${file} (${vector.description})\n  expected ${JSON.stringify(vector.expected)}\n  actual   ${JSON.stringify(state)}`,
          );
        }
      } catch (err) {
        failures.push(`${file} (${vector.description}) threw: ${String(err)}`);
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);
});
