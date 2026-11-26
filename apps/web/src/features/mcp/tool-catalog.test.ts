import { describe, expect, test } from "bun:test";
import { connectionState, shapeToolCall, shapeToolCatalog, toolParameters } from "./tool-catalog";

const catalogBody = {
  status: "connected",
  latencyMs: 84,
  schemaHash: "abc123",
  tools: [
    {
      name: "read_document",
      description: "Read a document by id",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The document id" },
          format: { type: ["text", "html"] },
          limit: { description: "Max bytes" },
        },
        required: ["id"],
      },
    },
    { name: "ping" },
    { description: "no name, skipped" },
    "not a tool",
  ],
};

describe("shapeToolCatalog", () => {
  test("keeps the endpoint's facts and one entry per named tool", () => {
    const catalog = shapeToolCatalog(catalogBody);
    expect(catalog.status).toBe("connected");
    expect(catalog.latencyMs).toBe(84);
    expect(catalog.schemaHash).toBe("abc123");
    expect(catalog.tools.map((tool) => tool.name)).toEqual(["read_document", "ping"]);
  });

  test("derives the parameter table from inputSchema", () => {
    const tool = shapeToolCatalog(catalogBody).tools[0];
    expect(tool?.parameters).toEqual([
      { name: "id", type: "string", required: true, description: "The document id" },
      { name: "format", type: "text | html", required: false, description: "" },
      { name: "limit", type: "—", required: false, description: "Max bytes" },
    ]);
    expect(tool?.inputSchema?.type).toBe("object");
  });

  test("a tool without a schema has no parameters and a null schema", () => {
    const ping = shapeToolCatalog(catalogBody).tools[1];
    expect(ping?.description).toBe("");
    expect(ping?.inputSchema).toBeNull();
    expect(ping?.parameters).toEqual([]);
  });

  test("a body that is not an object yields an empty catalog", () => {
    expect(shapeToolCatalog(undefined)).toEqual({
      status: "unknown",
      latencyMs: null,
      schemaHash: null,
      tools: [],
    });
  });

  test("an empty list is a list", () => {
    const catalog = shapeToolCatalog({ status: "connected", tools: [] });
    expect(catalog.tools).toEqual([]);
    expect(catalog.latencyMs).toBeNull();
  });
});

describe("toolParameters", () => {
  test("a schema without properties has no rows", () => {
    expect(toolParameters({ type: "object" })).toEqual([]);
    expect(toolParameters(null)).toEqual([]);
  });
});

describe("shapeToolCall", () => {
  test("text content is the result", () => {
    const outcome = shapeToolCall({
      result: { content: [{ type: "text", text: "pong" }] },
    });
    expect([outcome.ok]).toEqual([true]);
    expect(outcome.text).toBe("pong");
  });

  test("a tool error stays a failure", () => {
    const outcome = shapeToolCall({
      result: { content: [{ type: "text", text: "echo failed on purpose" }], isError: true },
    });
    expect([outcome.ok, outcome.text]).toEqual([false, "echo failed on purpose"]);
  });

  test("a failed request stays a failure", () => {
    expect(shapeToolCall({ error: "server not connected" })).toEqual({
      ok: false,
      text: "server not connected",
    });
    expect([shapeToolCall(null).ok]).toEqual([false]);
  });

  test("a result without text is shown as JSON", () => {
    const outcome = shapeToolCall({ result: { content: [], count: 2 } });
    expect([outcome.ok, outcome.text]).toEqual([true, '{\n  "content": [],\n  "count": 2\n}']);
  });

  test("no result at all is a failure, not a success with empty text", () => {
    expect(shapeToolCall({}).ok).toBe(false);
    expect(shapeToolCall({ result: "raw string" }).ok).toBe(false);
  });
});

describe("connectionState", () => {
  test("each status a person can tell apart", () => {
    expect(connectionState(undefined)).toBe("never tested");
    expect(connectionState(null)).toBe("never tested");
    expect(connectionState("pending")).toBe("connecting");
    expect(connectionState("connected")).toBe("connected");
    expect(connectionState("failed")).toBe("failed");
  });
});
