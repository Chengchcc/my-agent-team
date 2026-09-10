import { describe, expect, test } from "bun:test";
import { HttpError } from "./errors.js";

describe("HttpError", () => {
  test("carries message and status for the onError translator", () => {
    const err = new HttpError("branch not found", 404);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("HttpError");
    expect(err.message).toBe("branch not found");
    expect(err.status).toBe(404);
  });
});
