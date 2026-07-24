import { describe, expect, test } from "bun:test";
import { Agent } from "./agent.js";
import { echoModel } from "@my-agent-team/test-helpers";
import type { AgentHooks, AgentContext } from "./agent-hooks.js";

describe("AgentHooks", () => {
  test("before:model transformer", async () => {
    let transformed = false;
    const hooks: AgentHooks = {
      "before:model": (_ctx, msgs) => {
        transformed = true;
        return msgs;
      },
    };
    const agent = new Agent({ model: echoModel({ turns: [{ type: "text", text: "ok" }] }), hooks });
    await agent.prompt("hi");
    expect(transformed).toBe(true);
  });

  test("after:model observer", async () => {
    let observed = false;
    const hooks: AgentHooks = {
      "after:model": () => {
        observed = true;
      },
    };
    const agent = new Agent({ model: echoModel({ turns: [{ type: "text", text: "ok" }] }), hooks });
    await agent.prompt("hi");
    expect(observed).toBe(true);
  });

  test("before:run transformer", async () => {
    let ran = false;
    const hooks: AgentHooks = {
      "before:run": () => {
        ran = true;
      },
    };
    const agent = new Agent({ model: echoModel({ turns: [{ type: "text", text: "ok" }] }), hooks });
    await agent.prompt("hi");
    expect(ran).toBe(true);
  });

  test("before:stop preserves force-continue", async () => {
    let stopped = false;
    const hooks: AgentHooks = {
      "before:stop": () => {
        stopped = true;
        return { continue: true, reason: "test" };
      },
    };
    const agent = new Agent({
      model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
      hooks,
      maxSteps: 2,
    });
    await agent.prompt("should trigger stop check");
    expect(stopped).toBe(true);
  });

  test("hooks execute in registration order", async () => {
    const order: string[] = [];
    const hooks: AgentHooks = {
      "before:model": () => {
        order.push("first");
        return [...msgs];
      },
      "after:model": () => {
        order.push("second");
      },
    };
    const agent = new Agent({ model: echoModel({ turns: [{ type: "text", text: "ok" }] }), hooks });
    await agent.prompt("hi");
    expect(order).toEqual(["first", "second"]);
  });

  test("hook error is logged, not thrown", async () => {
    let errCount = 0;
    const hooks: AgentHooks = {
      "before:model": () => {
        errCount++;
        throw new Error("boom");
      },
    };
    const agent = new Agent({ model: echoModel({ turns: [{ type: "text", text: "ok" }] }), hooks });
    // Should complete without throwing
    await agent.prompt("hi");
    expect(errCount).toBe(1);
  });
});
