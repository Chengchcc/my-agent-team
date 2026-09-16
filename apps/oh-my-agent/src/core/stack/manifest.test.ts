import { describe, expect, test } from "bun:test";
import {
  componentDir,
  parseStackManifest,
  resolveComponentEnv,
  resolvePlaceholders,
  StackManifestError,
  startupOrder,
} from "./manifest.js";

const minimal = {
  schemaVersion: 1,
  name: "test-stack",
  version: "1.2.3",
  components: [{ name: "backend", runtime: "bun", cwd: "backend", entry: "main.js" }],
};

describe("parseStackManifest", () => {
  test("accepts a minimal manifest and defaults the optional arrays", () => {
    const manifest = parseStackManifest(minimal);
    expect(manifest.components[0]?.secrets).toEqual([]);
    expect(manifest.components[0]?.env).toEqual({});
    expect(manifest.components[0]?.runtime).toBe("bun");
  });

  test("rejects an unknown schemaVersion instead of guessing", () => {
    expect(() => parseStackManifest({ ...minimal, schemaVersion: 2 })).toThrow(StackManifestError);
  });

  test("rejects a component without an entry", () => {
    expect(() =>
      parseStackManifest({
        ...minimal,
        components: [{ name: "backend", runtime: "bun", cwd: "backend" }],
      }),
    ).toThrow(StackManifestError);
  });
});

describe("placeholders", () => {
  const ctx = {
    root: "/opt/stack",
    dataDir: "/home/u/.oma/stack-data",
    omaBin: "/usr/local/bin/oma",
    secrets: { BACKEND_AUTH_TOKEN: "s3cret" },
  };

  test("resolves root, dataDir, omaBin and secrets", () => {
    expect(resolvePlaceholders("{root}/backend/main.js", ctx)).toBe("/opt/stack/backend/main.js");
    expect(resolvePlaceholders("{dataDir}/backend", ctx)).toBe("/home/u/.oma/stack-data/backend");
    expect(resolvePlaceholders("{omaBin}", ctx)).toBe("/usr/local/bin/oma");
    expect(resolvePlaceholders("{secret:BACKEND_AUTH_TOKEN}", ctx)).toBe("s3cret");
  });

  test("throws on an unknown placeholder or a missing secret", () => {
    expect(() => resolvePlaceholders("{nope}", ctx)).toThrow(StackManifestError);
    expect(() => resolvePlaceholders("{secret:MISSING}", ctx)).toThrow(StackManifestError);
  });

  test("resolves every env value of a component", () => {
    const manifest = parseStackManifest({
      ...minimal,
      components: [
        {
          name: "backend",
          runtime: "bun",
          cwd: "backend",
          entry: "main.js",
          env: {
            BACKEND_DATA_DIR: "{dataDir}/backend",
            OMA_BIN: "{omaBin}",
            BACKEND_AUTH_TOKEN: "{secret:BACKEND_AUTH_TOKEN}",
          },
        },
      ],
    });
    const env = resolveComponentEnv(manifest.components[0]!, ctx);
    expect(env).toEqual({
      BACKEND_DATA_DIR: "/home/u/.oma/stack-data/backend",
      OMA_BIN: "/usr/local/bin/oma",
      BACKEND_AUTH_TOKEN: "s3cret",
    });
  });

  test("componentDir keeps the artifact root as the base", () => {
    expect(
      componentDir(
        {
          name: "w",
          runtime: "bun",
          cwd: "web/apps/web",
          entry: "server.js",
          env: {},
          secrets: [],
          dependsOn: [],
        },
        "/opt/stack",
      ),
    ).toBe("/opt/stack/web/apps/web");
  });
});

describe("startupOrder", () => {
  test("starts dependencies before dependents, keeping declaration order", () => {
    const manifest = parseStackManifest({
      ...minimal,
      components: [
        { name: "web", runtime: "bun", cwd: "web", entry: "server.js", dependsOn: ["backend"] },
        { name: "backend", runtime: "bun", cwd: "backend", entry: "main.js" },
        { name: "worker", runtime: "bun", cwd: "worker", entry: "main.js" },
      ],
    });
    expect(startupOrder(manifest).map((c) => c.name)).toEqual(["backend", "worker", "web"]);
  });

  test("rejects a dependency cycle", () => {
    const manifest = parseStackManifest({
      ...minimal,
      components: [
        { name: "a", runtime: "bun", cwd: "a", entry: "m.js", dependsOn: ["b"] },
        { name: "b", runtime: "bun", cwd: "b", entry: "m.js", dependsOn: ["a"] },
      ],
    });
    expect(() => startupOrder(manifest)).toThrow(StackManifestError);
  });
});

describe("declared secrets", () => {
  test("a component that declares a secret gets it injected under its own name", () => {
    const manifest = parseStackManifest({
      schemaVersion: 1,
      name: "t",
      version: "1.0.0",
      components: [
        {
          name: "backend",
          runtime: "bun",
          cwd: "backend",
          entry: "main.js",
          secrets: ["BACKEND_AUTH_TOKEN"],
        },
      ],
    });
    const env = resolveComponentEnv(manifest.components[0]!, {
      root: "/s",
      dataDir: "/d",
      omaBin: "/bin/oma",
      secrets: { BACKEND_AUTH_TOKEN: "tok" },
    });
    expect(env).toEqual({ BACKEND_AUTH_TOKEN: "tok" });
  });

  test("an explicit env entry wins over the injected secret", () => {
    const manifest = parseStackManifest({
      schemaVersion: 1,
      name: "t",
      version: "1.0.0",
      components: [
        {
          name: "backend",
          runtime: "bun",
          cwd: "backend",
          entry: "main.js",
          secrets: ["BACKEND_AUTH_TOKEN"],
          env: { BACKEND_AUTH_TOKEN: "from-env" },
        },
      ],
    });
    const env = resolveComponentEnv(manifest.components[0]!, {
      root: "/s",
      dataDir: "/d",
      omaBin: "/bin/oma",
      secrets: { BACKEND_AUTH_TOKEN: "tok" },
    });
    expect(env.BACKEND_AUTH_TOKEN).toBe("from-env");
  });

  test("a declared secret the launcher does not have is a manifest error", () => {
    const manifest = parseStackManifest({
      schemaVersion: 1,
      name: "t",
      version: "1.0.0",
      components: [
        { name: "backend", runtime: "bun", cwd: "backend", entry: "m.js", secrets: ["NOPE"] },
      ],
    });
    expect(() =>
      resolveComponentEnv(manifest.components[0]!, {
        root: "/s",
        dataDir: "/d",
        omaBin: "/bin/oma",
        secrets: {},
      }),
    ).toThrow(StackManifestError);
  });
});
