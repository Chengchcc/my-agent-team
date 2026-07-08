import { describe, expect, test } from "bun:test";
import {
  BusyError,
  ConflictError,
  DomainError,
  NotFoundError,
  ValidationError,
} from "./domain-errors.js";

describe("DomainError", () => {
  test("base DomainError has status 500", () => {
    const e = new DomainError("something broke");
    expect(e.status).toBe(500);
    expect(e.message).toBe("something broke");
    expect(e.name).toBe("DomainError");
    expect(e instanceof Error).toBe(true);
  });

  test("NotFoundError has status 404", () => {
    const e = new NotFoundError("Agent", "agent-1");
    expect(e.status).toBe(404);
    expect(e.message).toBe("Agent not found: agent-1");
    expect(e instanceof DomainError).toBe(true);
  });

  test("ValidationError has status 422", () => {
    const e = new ValidationError("name is required");
    expect(e.status).toBe(422);
    expect(e.message).toBe("name is required");
    expect(e instanceof DomainError).toBe(true);
  });

  test("BusyError has status 409", () => {
    const e = new BusyError("conversation-1");
    expect(e.status).toBe(409);
    expect(e.message).toContain("conversation-1");
    expect(e instanceof DomainError).toBe(true);
  });

  test("ConflictError has status 409", () => {
    const e = new ConflictError("duplicate name");
    expect(e.status).toBe(409);
    expect(e instanceof DomainError).toBe(true);
  });

  test("subclass name is set correctly", () => {
    expect(new NotFoundError("X", "1").name).toBe("NotFoundError");
    expect(new ValidationError("bad").name).toBe("ValidationError");
    expect(new BusyError("c1").name).toBe("BusyError");
    expect(new ConflictError("dup").name).toBe("ConflictError");
  });
});
