import { describe, expect, test } from "bun:test";
import { Agent } from "./agent.js";
import { echoModel } from "@my-agent-team/test-helpers";

describe("framework-adapter boundary", () => {
  test("Agent can be constructed without importing framework directly", () => {
    const agent = new Agent({ model: echoModel({ turns: [{ type: "text", text: "ok" }] }) });
    expect(agent.state).toBe("idle");
  });

  test("Agent prompt works through adapter", async () => {
    const agent = new Agent({ model: echoModel({ turns: [{ type: "text", text: "ok" }] }) });
    let done = false;
    agent.subscribe((e) => {
      if (e.type === "agent_end") done = true;
    });
    await agent.prompt("hi");
    expect(done).toBe(true);
  });

  test("index.ts does not re-export framework types directly", () => {
    // Verify the structural check: no 'from "@my-agent-team/framework"' in index.ts
    const fs = require("node:fs");
    const content = fs.readFileSync(require("node:path").join(__dirname, "index.ts"), "utf-8");
    expect(content).not.toContain('from "@my-agent-team/framework"');
  });
});
