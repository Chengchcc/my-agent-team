import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { codingAgentCommandSchema, responseOutputSchema } from "./transport.js";

/** ADR 0024 accepts a hand-maintained second copy of the wire contract on the
 *  adapter side; this is the guard that keeps the two copies honest. It reads
 *  the adapter's schema SOURCE (that package is outside this app's program)
 *  and compares its declarations with the child's own schema. Drift here has
 *  already shipped once: the child's `response.command` union omitted
 *  "resolve_approval", so every approval ack threw inside the reader loop and
 *  killed the command loop (steer/abort unreachable for the rest of the Run). */
const ADAPTER_PROTOCOL = new URL(
  "../../../../packages/adapter-oma-agent/src/protocol.ts",
  import.meta.url,
).pathname;

/** Command types the adapter can SEND: every `type: z.literal("…")` in the
 *  COMMAND region (the output schemas reuse the same literal keyword). */
function adapterCommandTypes(source: string): string[] {
  const from = source.indexOf("export const executeCommandSchema");
  const to = source.indexOf("export const codingAgentCommandSchema");
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  const region = source.slice(from, to);
  return [...region.matchAll(/type:\s*z\.literal\("([a-z_]+)"\)/g)].map((m) => m[1]!);
}

/** The `command:` enum of a response-envelope declaration. */
function responseCommandEnum(source: string, declaration: string): string[] {
  const start = source.indexOf(declaration);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = source.slice(start, source.indexOf("});", start));
  const match = body.match(/command:\s*z\.enum\(\[([^\]]*)\]\)/);
  expect(match, `${declaration} must declare command: z.enum([...])`).not.toBeNull();
  return (match![1] ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

const CHILD_RESPONSE_COMMANDS = responseCommandEnum(
  readFileSync(new URL("./transport.ts", import.meta.url).pathname, "utf8"),
  "export const responseOutputSchema",
);

describe("oma wire protocol drift (child vs adapter)", () => {
  const adapter = readFileSync(ADAPTER_PROTOCOL, "utf8");
  const sent = adapterCommandTypes(adapter);

  test("both sides agree on the command vocabulary", () => {
    const adapterResponses = responseCommandEnum(adapter, "export const responseOutputSchema");
    // The adapter's response enum is the reference for "what can be sent".
    expect([...adapterResponses].sort()).toEqual([...new Set(sent)].sort());
    // …and the child must be able to answer every one of them.
    expect([...CHILD_RESPONSE_COMMANDS].sort()).toEqual([...adapterResponses].sort());
  });

  test("the child parses every command the adapter sends, and encodes the ack", () => {
    expect(sent.length).toBeGreaterThan(0);
    for (const type of new Set(sent)) {
      const ack = responseOutputSchema.safeParse({
        id: "x",
        type: "response",
        command: type,
        success: true,
      });
      expect(ack.success, `child must encode a "${type}" response`).toBe(true);

      const command = codingAgentCommandSchema.safeParse({
        id: "c1",
        type,
        runId: "r1",
        ...(type === "execute"
          ? {
              input: {
                input: { inputId: "i", message: { role: "user", text: "hi" } },
                run: {
                  runId: "r1",
                  model: { backendKind: "oma", modelId: "m/m" },
                  configRevision: 1,
                },
                workspace: { root: "/tmp", access: "read_only" },
                metadata: { conversationId: "c", agentId: "a", branchId: "b" },
              },
            }
          : {}),
        ...(type === "steer"
          ? { input: { inputId: "i", message: { role: "user", text: "hi" } } }
          : {}),
        ...(type === "resolve_approval" ? { callId: "toolu-1", decision: "allow" } : {}),
      });
      expect(command.success, `child must parse a "${type}" command`).toBe(true);
    }
  });
});
