import { describe, expect, test } from "bun:test";
import { echoModel } from "@my-agent-team/test-helpers";
import { Agent } from "./agent.js";
import type { AgentHooks } from "./agent-hooks.js";

describe("AgentHooks", () => {
  test("before:model transformer", async () => {
    let transformed = false;
    const hooks: AgentHooks = {
      "before:model": (_ctx, msgs) => {
        transformed = true;
        return msgs.slice();
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
        return { text: "ok" };
      },
    };
    const agent = new Agent({ model: echoModel({ turns: [{ type: "text", text: "ok" }] }), hooks });
    await agent.prompt("hi");
    expect(ran).toBe(true);
  });

  test("before:stop observer", async () => {
    let stopped = false;
    const hooks: AgentHooks = {
      "before:stop": () => {
        stopped = true;
        return undefined as ReturnType<NonNullable<AgentHooks["before:stop"]>>;
      },
    };
    const agent = new Agent({
      model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
      hooks,
      maxSteps: 1,
    });
    await agent.prompt("hi");
    expect(stopped).toBe(true);
  });

  test("hook error is logged, not thrown", async () => {
    let errCount = 0;
    const hooks: AgentHooks = {
      "before:model": (_ctx, _msgs) => {
        errCount++;
        throw new Error("boom");
      },
    };
    const agent = new Agent({ model: echoModel({ turns: [{ type: "text", text: "ok" }] }), hooks });
    await agent.prompt("hi");
    expect(errCount).toBe(1);
  });

  test("hooks execute in order", async () => {
    const order: string[] = [];
    const hooks: AgentHooks = {
      "before:model": (_ctx, msgs) => {
        order.push("first");
        return msgs.slice();
      },
      "after:model": () => {
        order.push("second");
      },
    };
    const agent = new Agent({ model: echoModel({ turns: [{ type: "text", text: "ok" }] }), hooks });
    await agent.prompt("hi");
    expect(order).toEqual(["first", "second"]);
  });
});
