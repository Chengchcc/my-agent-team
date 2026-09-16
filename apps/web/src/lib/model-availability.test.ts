import { describe, expect, test } from "bun:test";
import { blockedBackends, usableBackends } from "./model-availability";

describe("usableBackends", () => {
  test("collects the kinds that have at least one usable model", () => {
    expect(
      usableBackends([
        { backendKind: "oma" },
        { backendKind: "oma" },
        { backendKind: "omp" },
        { backendKind: "pi", available: false },
      ]),
    ).toEqual(["oma", "omp"]);
  });

  test("is empty for an unconfigured deployment", () => {
    expect(usableBackends([])).toEqual([]);
  });
});

describe("blockedBackends", () => {
  test("names the kind of an agent whose backend has no model", () => {
    expect(blockedBackends([{ backendKind: "oma" }], [])).toEqual(["oma"]);
  });

  test("says nothing when every enabled agent can run", () => {
    expect(
      blockedBackends(
        [{ backendKind: "oma" }, { backendKind: "omp" }],
        [{ backendKind: "oma" }, { backendKind: "omp" }],
      ),
    ).toEqual([]);
  });

  test("ignores disabled agents and unavailable models", () => {
    expect(
      blockedBackends(
        [{ backendKind: "oma", enabled: false }, { backendKind: "omp" }],
        [{ backendKind: "oma" }, { backendKind: "omp", available: false }],
      ),
    ).toEqual(["omp"]);
  });

  test("reports each blocked kind once, sorted", () => {
    expect(
      blockedBackends([{ backendKind: "pi" }, { backendKind: "oma" }, { backendKind: "pi" }], []),
    ).toEqual(["oma", "pi"]);
  });
});
