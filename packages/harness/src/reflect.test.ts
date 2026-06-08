import { describe, expect, test } from "bun:test";
import { reflectionGuidance } from "./reflect.js";

describe("reflectionGuidance", () => {
  test("returns non-empty string", () => {
    const guidance = reflectionGuidance();
    expect(guidance.length).toBeGreaterThan(50);
  });

  test("mentions memory/{date}.md as target for learnings", () => {
    const guidance = reflectionGuidance();
    expect(guidance).toInclude("memory");
  });

  test("mentions SOUL.md and USER.md for stable fact backflow", () => {
    const guidance = reflectionGuidance();
    expect(guidance).toInclude("SOUL.md");
    expect(guidance).toInclude("USER.md");
  });

  test("references write and edit tools", () => {
    const guidance = reflectionGuidance();
    expect(guidance).toInclude("write tool");
    expect(guidance).toInclude("edit tool");
  });

  test("includes weak constraint against overwriting core boundaries", () => {
    const guidance = reflectionGuidance();
    expect(guidance).toInclude("append");
    expect(guidance).toInclude("overwrite");
    expect(guidance).toInclude("core boundaries");
  });

  test("tells agent it can choose to do nothing if nothing worth saving", () => {
    const guidance = reflectionGuidance();
    expect(guidance).toInclude("nothing");
  });
});
