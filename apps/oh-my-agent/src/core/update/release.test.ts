import { describe, expect, test } from "bun:test";
import {
  fetchLatestRelease,
  isNewer,
  newerVersion,
  parseLatestRelease,
  UpdateCheckError,
} from "./release.js";

/** A registry stand-in: the check path is only believable if it reads a real
 *  HTTP response body, not a hand-built object. */
function serveRegistry(handler: (path: string) => Response): { base: string; close: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => handler(new URL(req.url).pathname),
  });
  return { base: `http://127.0.0.1:${server.port}`, close: () => server.stop(true) };
}

describe("parseLatestRelease", () => {
  test("takes the highest version across the channels, not the stable tag", () => {
    // The real state of the registry while 0.2.0 is in rc: `latest` lags.
    const parsed = parseLatestRelease({
      "dist-tags": { latest: "0.1.1-rc.1", rc: "0.2.0-rc.4" },
    });
    expect(parsed).toEqual({ version: "0.2.0-rc.4", tag: "rc" });
  });

  test("a released version beats a prerelease of the same number", () => {
    expect(parseLatestRelease({ "dist-tags": { latest: "0.2.0", rc: "0.2.0-rc.4" } }).version).toBe(
      "0.2.0",
    );
  });

  test("latest wins a tie (stable channel preferred)", () => {
    expect(parseLatestRelease({ "dist-tags": { latest: "1.0.0", rc: "1.0.0" } }).tag).toBe(
      "latest",
    );
  });

  test("ignores unknown tags and missing entries", () => {
    expect(parseLatestRelease({ "dist-tags": { beta: "9.9.9", rc: "0.2.0" } }).version).toBe(
      "0.2.0",
    );
  });

  test("an unparseable version is an error, not a silent skip", () => {
    expect(() => parseLatestRelease({ "dist-tags": { latest: "not-a-version" } })).toThrow(
      UpdateCheckError,
    );
  });

  test("rejects bodies that are not registry manifests", () => {
    expect(() => parseLatestRelease("<html>proxy error</html>")).toThrow(UpdateCheckError);
    expect(() => parseLatestRelease({})).toThrow(/no dist-tags/);
    expect(() => parseLatestRelease({ "dist-tags": { beta: "1.0.0" } })).toThrow(/none of/);
  });
});

describe("fetchLatestRelease", () => {
  test("reads dist-tags over HTTP", async () => {
    const server = serveRegistry(() =>
      Response.json({ "dist-tags": { latest: "0.1.1-rc.1", rc: "0.2.0-rc.4" } }),
    );
    try {
      expect(await fetchLatestRelease({ registry: server.base })).toEqual({
        version: "0.2.0-rc.4",
        tag: "rc",
      });
    } finally {
      server.close();
    }
  });

  test("an HTTP error is reported with the URL", async () => {
    const server = serveRegistry(() => new Response("nope", { status: 503 }));
    try {
      await expect(fetchLatestRelease({ registry: server.base })).rejects.toThrow(/HTTP 503/);
    } finally {
      server.close();
    }
  });

  test("a non-JSON body is an error, never 'no update'", async () => {
    const server = serveRegistry(() => new Response("<html>captive portal</html>"));
    try {
      await expect(fetchLatestRelease({ registry: server.base })).rejects.toThrow(
        /did not return JSON/,
      );
    } finally {
      server.close();
    }
  });
});

describe("isNewer", () => {
  test("orders prereleases the way npm does", () => {
    expect(isNewer("0.2.0-rc.4", "0.2.0-rc.3")).toBe(true);
    expect(isNewer("0.2.0", "0.2.0-rc.4")).toBe(true);
    expect(isNewer("0.2.0-rc.3", "0.2.0-rc.4")).toBe(false);
    expect(isNewer("0.1.1-rc.1", "0.2.0-rc.3")).toBe(false);
  });

  test("an unparseable version is never newer", () => {
    expect(isNewer("garbage", "0.2.0")).toBe(false);
    expect(isNewer("1.0.0", "garbage")).toBe(false);
  });
});

describe("newerVersion (the hint's fail-open wrapper)", () => {
  test("reports a newer release", async () => {
    const server = serveRegistry(() => Response.json({ "dist-tags": { rc: "0.2.0-rc.4" } }));
    try {
      expect(await newerVersion("0.2.0-rc.3", { registry: server.base })).toBe("0.2.0-rc.4");
    } finally {
      server.close();
    }
  });

  test("stays silent when current", async () => {
    const server = serveRegistry(() => Response.json({ "dist-tags": { rc: "0.2.0-rc.4" } }));
    try {
      expect(await newerVersion("0.2.0-rc.4", { registry: server.base })).toBeUndefined();
    } finally {
      server.close();
    }
  });

  test("an unreachable registry is not an update (and does not throw)", async () => {
    // Port 1 is reserved and never listening.
    expect(await newerVersion("0.2.0-rc.3", { registry: "http://127.0.0.1:1" })).toBeUndefined();
  });
});
