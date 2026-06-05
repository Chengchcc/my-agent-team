import { describe, expect, test } from "bun:test";
import { consoleLogger } from "@my-agent-team/framework";
import { readOrEmpty } from "./workspace-reader.js";

describe("readOrEmpty", () => {
  const logger = consoleLogger({ level: "silent" });

  test("returns file content when file exists", async () => {
    const tmpPath = `/tmp/test-wsread-${Date.now()}.txt`;
    await Bun.write(tmpPath, "hello workspace");

    const result = await readOrEmpty(tmpPath, logger);
    expect(result).toBe("hello workspace");
  });

  test("returns empty string on ENOENT", async () => {
    const result = await readOrEmpty("/tmp/nonexistent-wsread.txt", logger);
    expect(result).toBe("");
  });

  test("returns empty string and warns on EACCES", async () => {
    // Create a file without read permissions
    // EACCES is hard to trigger reliably as root; skip actual EACCES
    // and just verify that non-ENOENT errors return empty string
    const warnings: string[] = [];
    const warnLogger = {
      ...logger,
      warn: (msg: string) => {
        warnings.push(msg);
      },
    };

    // Read a directory as if it were a file → should fail with EISDIR
    const result = await readOrEmpty("/tmp", warnLogger);
    expect(result).toBe("");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toInclude("harness: read");
  });
});
