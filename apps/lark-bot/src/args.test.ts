import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args.js";


// parseArgs calls parseEnv which requires BACKEND_AUTH_TOKEN
process.env.BACKEND_AUTH_TOKEN = "test-token";
describe("parseArgs", () => {
  test("parses required --agent-id", () => {
    const args = parseArgs(["--agent-id", "agent_123"]);
    expect(args.agentId).toBe("agent_123");
    expect(args.backendUrl).toBe("http://127.0.0.1:3000");
    expect(args.stateRoot).toBe("./.data");
    expect(args.botDisplayName).toBeNull();
    expect(args.agentName).toBeNull();
  });

  test("parses all optional args", () => {
    const args = parseArgs([
      "--agent-id",
      "agent_456",
      "--backend-url",
      "http://example.com:8080",
      "--state-root",
      "/var/data",
      "--bot-display-name",
      "MyBot",
      "--agent-name",
      "CustomAgent",
    ]);
    expect(args.agentId).toBe("agent_456");
    expect(args.backendUrl).toBe("http://example.com:8080");
    expect(args.stateRoot).toBe("/var/data");
    expect(args.botDisplayName).toBe("MyBot");
    expect(args.agentName).toBe("CustomAgent");
  });

  test("reads backendUrl from BACKEND_URL env", () => {
    const prev = process.env.BACKEND_URL;
    process.env.BACKEND_URL = "http://env-backend:4000";
    try {
      const args = parseArgs(["--agent-id", "agent_789"]);
      expect(args.backendUrl).toBe("http://env-backend:4000");
    } finally {
      process.env.BACKEND_URL = prev;
    }
  });

  test("CLI flag overrides env", () => {
    const prev = process.env.BACKEND_URL;
    process.env.BACKEND_URL = "http://env-backend:4000";
    try {
      const args = parseArgs(["--agent-id", "x", "--backend-url", "http://cli:5000"]);
      expect(args.backendUrl).toBe("http://cli:5000");
    } finally {
      process.env.BACKEND_URL = prev;
    }
  });

  test("throws without --agent-id", () => {
    expect(() => parseArgs(["--other-arg", "value"])).toThrow("--agent-id is required");
  });
});
