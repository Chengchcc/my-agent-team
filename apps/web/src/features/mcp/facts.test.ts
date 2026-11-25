import { describe, expect, test } from "bun:test";
import { bindChanges, bindingChange, bindingOf } from "./bindings";
import { mcpFacts } from "./facts";
import {
  createSettingsFrom,
  EMPTY_FORM,
  formFromServer,
  parseArgs,
  parsePairs,
  serversFromJson,
  updateSettingsFrom,
} from "./server-form";
import { shapeToolCatalog } from "./tool-catalog";

const stored = {
  serverId: "s1",
  name: "Docs",
  transport: "stdio" as const,
  command: "npx",
  args: ["-y", "docs"],
  url: null,
};

describe("the write-only secret rule", () => {
  test("a form built from the server has no secret text to send", () => {
    const form = formFromServer(stored);
    expect(form.env).toBe("");
    expect(form.headers).toBe("");
    expect(form.name).toBe("Docs");
    expect(form.args).toBe("-y docs");
  });

  test("an untouched edit sends neither env nor headers", () => {
    const result = updateSettingsFrom(formFromServer(stored));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings).not.toHaveProperty("env");
    expect(result.settings).not.toHaveProperty("headers");
    expect(result.settings.args).toEqual(["-y", "docs"]);
  });

  test("what the person typed is sent as the whole new map", () => {
    const form = { ...formFromServer(stored), env: "TOKEN=abc\nBASE=https://x" };
    const result = updateSettingsFrom(form);
    if (!result.ok) throw new Error("expected a valid form");
    expect(result.settings.env).toEqual({ TOKEN: "abc", BASE: "https://x" });
    expect(result.settings).not.toHaveProperty("headers");
  });

  test("the server's mask, pasted back, is refused instead of saved", () => {
    const form = { ...EMPTY_FORM, name: "a", env: "TOKEN=****1234" };
    expect(updateSettingsFrom(form).ok).toBe(false);
    expect(createSettingsFrom(form).ok).toBe(false);
    expect(parsePairs("TOKEN=****1234")).toBeNull();
  });

  test("a line without = is refused rather than dropped", () => {
    expect(parsePairs("A=1\nBROKEN")).toBeNull();
    expect(parsePairs("=1")).toBeNull();
    expect(parsePairs("\n  \nA=1")).toEqual({ A: "1" });
    expect(parseArgs("  -y   docs\n-x ")).toEqual(["-y", "docs", "-x"]);
  });

  test("no body built from the form ever contains a masked value", () => {
    const forms = [
      formFromServer({ ...stored, env: { TOKEN: "****1234" } } as typeof stored),
      { ...EMPTY_FORM, name: "n", transport: "sse" as const, url: "https://x", headers: "" },
      { ...EMPTY_FORM, name: "n", env: "A=1" },
    ];
    for (const form of forms) {
      const body = JSON.stringify([updateSettingsFrom(form), createSettingsFrom(form)]);
      expect(body.includes("****")).toBe(false);
    }
  });
});

describe("serversFromJson", () => {
  test("reads a client config and a bare server", () => {
    const list = serversFromJson(
      JSON.stringify({ mcpServers: { docs: { command: "npx", args: ["-y", 1], env: { A: 2 } } } }),
    );
    expect(list).toEqual([
      { name: "docs", transport: "stdio", command: "npx", args: ["-y", "1"], env: { A: "2" } },
    ]);
    expect(serversFromJson('{"name":"x","type":"sse","url":"https://u"}')).toEqual([
      { name: "x", transport: "sse", url: "https://u" },
    ]);
  });

  test("refuses what it cannot read instead of guessing", () => {
    for (const raw of ["[]", "1", '{"a":1}', '{"mcpServers":{"":1}}', '{"transport":"stdio"}']) {
      expect(() => serversFromJson(raw)).toThrow();
    }
  });
});

describe("mcpFacts", () => {
  const row = {
    status: "connected",
    env: { TOKEN: "****1234", BASE: "https://x" },
    headers: { Authorization: "****abcd" },
  };

  test("states catalog, connection, runtime and secrets apart", () => {
    const facts = mcpFacts({ ...row, runtimeStatus: "failed", runtimeToolsCount: 2 }, undefined);
    expect(facts.catalog).toEqual({ discovered: false, count: 0 });
    expect(facts.connection).toBe("connected");
    expect(facts.runtime?.status).toBe("failed");
    expect(facts.secrets).toEqual({ env: 2, headers: 1 });
    expect(JSON.stringify(facts).includes("****")).toBe(false);
  });

  test("a discovered list decides the catalog; an absent runtime fact stays absent", () => {
    const catalog = shapeToolCatalog({ status: "failed", tools: [{ name: "a" }, { name: "b" }] });
    const facts = mcpFacts(row, catalog);
    expect(facts.catalog).toEqual({ discovered: true, count: 2 });
    expect(facts.connection).toBe("failed");
    expect(mcpFacts(row, undefined).runtime).toBeNull();
  });
});

describe("binding diff", () => {
  const members = [
    { id: "a", mcpServers: [{ serverId: "s", enabled: true }] },
    { id: "b", mcpServers: [{ serverId: "s", enabled: false }] },
    { id: "c", mcpServers: [{ serverId: "other", enabled: true }] },
    { id: "d" },
  ];

  test("a box that did not change writes nothing", () => {
    expect(bindingChange("bound", true)).toBe("keep");
    expect(bindingChange("disabled", false)).toBe("keep");
    expect(bindingChange("none", false)).toBe("keep");
    expect(bindChanges(members, "s", { a: true, b: false })).toEqual([]);
  });

  test("only the changed members are rewritten, other servers kept", () => {
    expect(bindChanges(members, "s", { a: false, b: true, c: true })).toEqual([
      { agentId: "a", mcpServers: [] },
      { agentId: "b", mcpServers: [{ serverId: "s", enabled: true }] },
      {
        agentId: "c",
        mcpServers: [
          { serverId: "other", enabled: true },
          { serverId: "s", enabled: true },
        ],
      },
    ]);
    expect(bindingOf(members[3] as (typeof members)[number], "s")).toBe("none");
  });
});
