/** Upstream conformance vectors (the upgrade gate of ADR 0040 decision 2).
 *
 *  Source: github.com/microsoft/agent-host-protocol, `types/test-cases/reducers/`, taken from
 *  tag `v0.9.0` - it **must match the dependency pinned in package.json**: the repository HEAD
 *  carries about a dozen more, and running those fails on actions upstream's own 0.9.0 reducers
 *  do not implement (measured). Only the three channel kinds we serve are included - root,
 *  session and chat, 218 vectors; upstream's other 54 (terminal, changeset, annotations,
 *
 *  automation, ...) belong to channels we do not serve and are left out. Every vector runs
 *  through our own server: dispatch its actions, subscribe on a fresh connection, and the
 *  snapshot must equal the expected state. That tests **our** seeding, reduction and
 *  snapshotting rather than upstream's reducers, which their own tests cover. */
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

/** Upstream serializes "no value" as an explicit `null` while a reducer's in-memory result
 *  omits the key. The two are synonymous, so both sides drop nulls before comparing (a null
 *  inside an array is meaningful and stays). */
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

/** The state source answers with this vector's initial state only; no other channel is involved. */
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
    // A hard-coded count: dropped vectors or a partial copy turn the gate red instead of
    // quietly running fewer.
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
