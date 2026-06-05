import { describe, expect, test } from "bun:test";
import { consoleLogger, noopLogger } from "./logger.js";

describe("consoleLogger", () => {
  test("level=info → debug noop, info not throw", () => {
    const logger = consoleLogger({ level: "info" });
    logger.debug("hidden"); // should not throw
    logger.info("shown"); // should not throw
  });

  test("level=warn → info/debug noop", () => {
    const logger = consoleLogger({ level: "warn" });
    logger.debug("d"); // noop
    logger.info("i"); // noop
    logger.warn("w"); // should not throw
  });

  test("level=silent → all noop", () => {
    const logger = noopLogger();
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(logger.level).toBe("silent");
  });

  test("level=debug → all called (noop style)", () => {
    const logger = consoleLogger({ level: "debug" });
    logger.debug("d");
    logger.info("i");
    expect(logger.level).toBe("debug");
  });

  test("default level is info", () => {
    const logger = consoleLogger();
    expect(logger.level).toBe("info");
  });

  test("custom level honored", () => {
    const logger = consoleLogger({ level: "error" });
    expect(logger.level).toBe("error");
  });
});
