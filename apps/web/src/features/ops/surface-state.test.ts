import { describe, expect, test } from "bun:test";
import { STALE_HEARTBEAT_MS, surfaceConnection } from "./surface-state";

describe("surfaceConnection", () => {
  test("a fresh heartbeat is whatever the surface says it is", () => {
    const now = 1_000_000;
    expect(surfaceConnection("running", now - 10_000, now)).toMatchObject({
      label: "connected",
      tone: "ok",
    });
  });

  test("three missed beats are a disconnect, not a surface still 'running'", () => {
    const now = 1_000_000;
    const stale = now - STALE_HEARTBEAT_MS - 1;
    expect(surfaceConnection("running", stale, now)).toMatchObject({
      label: "disconnected",
      tone: "err",
    });
  });

  test("a surface that never reported says so", () => {
    expect(surfaceConnection("running", null, 1_000_000)).toMatchObject({
      label: "never reported",
      tone: "muted",
    });
  });
});
