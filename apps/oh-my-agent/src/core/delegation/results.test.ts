import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAndValidate, spillResults } from "./results.js";

/** A subagent's structured output arrives as the model's final TEXT, so the
 *  shape models habitually choose is what lands here. A real 7-agent fan-out
 *  failed 5 agents with `schema output is not valid JSON: ```json …`: the
 *  reply was valid JSON inside a markdown fence. */
const schema = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
} as const;

const session = (text: string) =>
  ({ messages: [{ role: "assistant" as const, text }] }) as unknown as Parameters<
    typeof parseAndValidate
  >[0];

describe("spillResults is artifact-first", () => {
  test("every result lands on disk with a relative pointer + bounded preview", () => {
    const ws = mkdtempSync(join(tmpdir(), "oma-spill-"));
    try {
      const long = "x".repeat(5000);
      const [short, big] = spillResults(
        [
          { label: "a", text: "small", ok: true },
          { label: "b", text: long, ok: true },
        ],
        "batch-1",
        { workspaceRoot: ws, workspaceAccess: "read_write" },
      );
      // Small results are addressable too (omp always writes `<id>.md`), so a
      // caller can read any agent's full output by path.
      expect(short?.resultPath).toBe(".oma/workflow/batch-1/a0.result.md");
      expect(readFileSync(join(ws, short!.resultPath!), "utf8")).toBe("small");
      expect(short?.text).toBe("small");
      // The big one keeps only the excerpt inline.
      expect(big?.resultPath).toBe(".oma/workflow/batch-1/a1.result.md");
      expect(readFileSync(join(ws, big!.resultPath!), "utf8")).toBe(long);
      expect(big!.text.length).toBeLessThan(long.length);
      expect(big?.text.endsWith("…")).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("read_only workspaces bound the inline text instead of spilling", () => {
    const ws = mkdtempSync(join(tmpdir(), "oma-spill-ro-"));
    try {
      const [r] = spillResults([{ label: "a", text: "y".repeat(5000), ok: true }], "b", {
        workspaceRoot: ws,
        workspaceAccess: "read_only",
      });
      expect(r?.resultPath).toBeUndefined();
      expect(r!.text).toContain("[truncated]");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("parseAndValidate tolerates the shapes models actually emit", () => {
  test("a fenced JSON reply parses (the fan-out regression)", () => {
    const reply = '```json\n{\n  "summary": "adapter layer"\n}\n```';
    const out = parseAndValidate(session(reply), schema);
    expect(out.parseError).toBeUndefined();
    expect(out.output).toEqual({ summary: "adapter layer" });
  });

  test("an unlabelled fence parses too", () => {
    const out = parseAndValidate(session('```\n{"summary": "x"}\n```'), schema);
    expect(out.parseError).toBeUndefined();
    expect(out.output).toEqual({ summary: "x" });
  });

  test("prose wrapped around the payload still parses", () => {
    const reply = 'Here is the result:\n{"summary": "wrapped"}\nHope it helps.';
    const out = parseAndValidate(session(reply), schema);
    expect(out.parseError).toBeUndefined();
    expect(out.output).toEqual({ summary: "wrapped" });
  });

  test("a bare JSON reply keeps working", () => {
    const out = parseAndValidate(session('{"summary": "plain"}'), schema);
    expect(out.parseError).toBeUndefined();
    expect(out.output).toEqual({ summary: "plain" });
  });

  test("genuinely invalid text still reports the violation", () => {
    const out = parseAndValidate(session("no json at all"), schema);
    expect(out.parseError).toContain("not valid JSON");
  });

  test("valid JSON that violates the schema reports validation, not parsing", () => {
    const out = parseAndValidate(session('{"other": 1}'), schema);
    expect(out.parseError).toContain("schema validation failed");
  });

  test("no schema and no text are both no-ops", () => {
    expect(parseAndValidate(session("anything"), undefined)).toEqual({ text: "anything" });
    expect(parseAndValidate(session(""), schema)).toEqual({ text: "" });
  });
});
