import { describe, expect, test } from "bun:test";
import { dispatcherOf, requestOwnerOf } from "./request-owner.js";

describe("ADR 0075: who owns a parked request", () => {
  test("dispatched work belongs to its dispatcher", () => {
    expect(requestOwnerOf({ authorization: "dispatch:pa-1" })).toEqual({
      owner: "agent:pa-1",
      agentId: "pa-1",
    });
    expect(requestOwnerOf({ authorization: "handback:pa-1" }).owner).toBe("agent:pa-1");
  });

  test("human, ambient and system runs belong to the human", () => {
    for (const authorization of ["user", "ambient:rule-1", "system", null]) {
      expect(requestOwnerOf({ authorization })).toEqual({ owner: "user", agentId: null });
    }
  });

  test("a worker dispatcher escalates past itself - it knows no more than the asker", () => {
    expect(requestOwnerOf({ authorization: "dispatch:worker-2", roleOf: () => "worker" })).toEqual({
      owner: "user",
      agentId: null,
    });
    // A front dispatcher keeps the request.
    expect(requestOwnerOf({ authorization: "dispatch:pa-1", roleOf: () => "front" }).owner).toBe(
      "agent:pa-1",
    );
  });

  test("dispatcherOf only reads the two dispatch bases", () => {
    expect(dispatcherOf("dispatch:a")).toBe("a");
    expect(dispatcherOf("handback:b")).toBe("b");
    expect(dispatcherOf("result:c")).toBeNull();
    expect(dispatcherOf("user")).toBeNull();
  });
});
