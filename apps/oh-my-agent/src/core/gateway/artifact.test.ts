import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentVersion,
  ensureSecrets,
  fetchGatewayArtifact,
  GatewayArtifactError,
  gatewayPaths,
  installedVersions,
  parseSums,
  readSecrets,
  releaseLocation,
  sha256File,
} from "./artifact.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const manifest = JSON.stringify({
  schemaVersion: 1,
  name: "test-gateway",
  version: "1.2.3",
  components: [{ name: "backend", runtime: "bun", cwd: "backend", entry: "main.js" }],
});

/** Build a real tar.zst artifact and serve it like a release: the fetch path is
 *  only believable if it unpacks what the packer writes. */
async function serveRelease(
  version: string,
  opts: { corruptSums?: boolean } = {},
): Promise<{ baseUrl: string; close: () => void }> {
  const stage = tempDir("oma-stage-");
  writeFileSync(join(stage, "gateway.json"), manifest);
  mkdirSync(join(stage, "backend"));
  writeFileSync(join(stage, "backend", "main.js"), 'console.log("backend");\n');
  // The tarball must live OUTSIDE the packed directory, or tar reports
  // "file changed as we read it".
  const artifactDir = tempDir("oma-artifact-");
  const tarball = join(artifactDir, `oma-gateway-${version}.tar.zst`);
  const tar = Bun.spawnSync(["tar", "--zstd", "-cf", tarball, "-C", stage, "."]);
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
  const digest = await sha256File(tarball);
  const sums = `${opts.corruptSums ? "0".repeat(64) : digest}  oma-gateway-${version}.tar.zst\n`;
  const tarballBytes = Bun.file(tarball);

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/SHA256SUMS")) return new Response(sums);
      if (path.endsWith(`/oma-gateway-${version}.tar.zst`)) return new Response(tarballBytes);
      return new Response("not found", { status: 404 });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    close: () => {
      server.stop(true);
      rmSync(stage, { recursive: true, force: true });
      rmSync(artifactDir, { recursive: true, force: true });
    },
  };
}

const HAS_ZSTD = Bun.which("zstd") !== null;

describe("releaseLocation", () => {
  test("targets the GitHub release for a version", () => {
    const loc = releaseLocation("0.2.0", {});
    expect(loc.tarball).toBe(
      "https://github.com/Chengchcc/my-agent-team/releases/download/v0.2.0/oma-gateway-0.2.0.tar.zst",
    );
    expect(loc.sums.endsWith("/SHA256SUMS")).toBe(true);
  });

  test("honors a mirror and a repo override", () => {
    expect(
      releaseLocation("1.0.0", { OMA_GATEWAY_BASE_URL: "http://localhost:9/x/" }).tarball,
    ).toBe("http://localhost:9/x/oma-gateway-1.0.0.tar.zst");
    expect(releaseLocation("1.0.0", { OMA_GATEWAY_REPO: "me/other" }).tarball).toContain(
      "github.com/me/other",
    );
  });
});

describe("parseSums", () => {
  test("finds the entry and tolerates the binary marker", () => {
    const digest = "a".repeat(64);
    expect(parseSums(`${digest}  *oma-gateway-1.0.0.tar.zst\n`, "oma-gateway-1.0.0.tar.zst")).toBe(
      digest,
    );
  });

  test("throws when the file is not listed", () => {
    expect(() => parseSums(`${"b".repeat(64)}  other.tar.zst\n`, "wanted.tar.zst")).toThrow(
      GatewayArtifactError,
    );
  });
});

describe("sha256File", () => {
  test("matches the known digest of 'abc'", async () => {
    const dir = tempDir("oma-sha-");
    const file = join(dir, "abc.txt");
    writeFileSync(file, "abc");
    expect(await sha256File(file)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("secrets", () => {
  test("generates the missing ones, keeps existing ones, and stays 0600", async () => {
    const home = tempDir("oma-home-");
    const first = await ensureSecrets(home, ["BACKEND_AUTH_TOKEN", "SESSION_SECRET"]);
    expect(first.BACKEND_AUTH_TOKEN).toMatch(/^[0-9a-f]{48}$/);
    expect(statSync(gatewayPaths(home).secrets).mode & 0o777).toBe(0o600);

    const second = await ensureSecrets(home, ["BACKEND_AUTH_TOKEN", "MOCK_PASSWORD"]);
    expect(second.BACKEND_AUTH_TOKEN).toBe(first.BACKEND_AUTH_TOKEN);
    // The login password is the one a human retypes: ~128 bits over an
    // alphabet without look-alikes (l, 1, I, O, 0) instead of 48 hex chars.
    expect(second.MOCK_PASSWORD).toMatch(/^[A-HJ-NP-Za-km-z2-9]{22}$/);
    expect(second.MOCK_PASSWORD).not.toMatch(/[l1IO0]/);
    expect(readSecrets(home).SESSION_SECRET).toBe(first.SESSION_SECRET);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("fetchGatewayArtifact", () => {
  test.skipIf(!HAS_ZSTD)("downloads, verifies, unpacks, then reuses the install", async () => {
    const home = tempDir("oma-home-");
    const release = await serveRelease("1.2.3");
    const env = { OMA_GATEWAY_BASE_URL: release.baseUrl };
    try {
      const logs: string[] = [];
      const first = await fetchGatewayArtifact({
        home,
        version: "1.2.3",
        env,
        log: (l) => logs.push(l),
      });
      expect(first.downloaded).toBe(true);
      expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(installedVersions(home)).toEqual(["1.2.3"]);
      expect(currentVersion(home)).toBe("1.2.3");
      expect(logs.some((l) => l.includes("verified sha256"))).toBe(true);

      const second = await fetchGatewayArtifact({ home, version: "1.2.3", env });
      expect(second.downloaded).toBe(false);
    } finally {
      release.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(!HAS_ZSTD)("refuses an artifact whose checksum does not match", async () => {
    const home = tempDir("oma-home-");
    const release = await serveRelease("2.0.0", { corruptSums: true });
    try {
      await expect(
        fetchGatewayArtifact({
          home,
          version: "2.0.0",
          env: { OMA_GATEWAY_BASE_URL: release.baseUrl },
        }),
      ).rejects.toThrow(/checksum mismatch/);
      expect(installedVersions(home)).toEqual([]);
    } finally {
      release.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("download stall", () => {
  test.skipIf(!HAS_ZSTD)(
    "a wedged download fails fast instead of hanging",
    async () => {
      const home = tempDir("oma-home-");
      // Valid sums for the name, but the tarball body never finishes.
      const sums = `${"a".repeat(64)}  oma-gateway-3.0.0.tar.zst\n`;
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          const path = new URL(req.url).pathname;
          if (path.endsWith("/SHA256SUMS")) return new Response(sums);
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("partial"));
                // …and then nothing, forever.
              },
            }),
          );
        },
      });
      try {
        await expect(
          fetchGatewayArtifact({
            home,
            version: "3.0.0",
            env: { OMA_GATEWAY_BASE_URL: `http://127.0.0.1:${server.port}` },
            stallMs: 300,
          }),
        ).rejects.toThrow(/stalled/);
        expect(installedVersions(home)).toEqual([]);
      } finally {
        server.stop(true);
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
