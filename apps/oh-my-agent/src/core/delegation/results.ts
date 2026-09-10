import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OmaSession } from "../agent-runtime.js";
import type { SubagentResult, SubagentSpec } from "./executor.js";

/** A3 fan-in size guard: per-item inline ceiling, total inline budget, and
 *  the excerpt length kept in the tool result when a text is spilled. */
const MAX_INLINE_ITEM_CHARS = 2000;
const MAX_TOTAL_INLINE_CHARS = 16_000;
const EXCERPT_CHARS = 400;

/** A2: minimal JSON-Schema subset validator for model-supplied output
 *  schemas — covers type / properties / required / enum / items (the exact
 *  Loop triage shape). Unknown keywords pass through; this is a guard, not
 *  a full validator.
 *  Upgrade path: replace with provider-native structured output
 *  (ChatModel.stream responseFormat) once that lands; the validator then
 *  stays as a backstop and the schema-correction retry is kept. */
function matchesSchemaType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      return true; // unknown types never reject
  }
}

/** Returns a human-readable violation, or undefined when the value
 *  conforms to the supported subset. */
export function validateJsonSchema(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
): string | undefined {
  const types = (
    Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  ) as string[];
  if (types.length > 0 && !types.some((t) => matchesSchemaType(t, value))) {
    return `expected ${types.join("|")}, got ${value === null ? "null" : typeof value}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `value not in enum (${JSON.stringify(schema.enum).slice(0, 120)})`;
  }
  if (matchesSchemaType("object", value)) {
    const record = value as Record<string, unknown>;
    for (const key of (schema.required as readonly string[] | undefined) ?? []) {
      if (!(key in record)) return `missing required property "${key}"`;
    }
    const props = schema.properties as Readonly<Record<string, unknown>> | undefined;
    if (props) {
      for (const [key, propSchema] of Object.entries(props)) {
        if (key in record) {
          const err = validateJsonSchema(
            record[key],
            propSchema as Readonly<Record<string, unknown>>,
          );
          if (err) return `${key}: ${err}`;
        }
      }
    }
    return undefined;
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const err = validateJsonSchema(value[i], schema.items as Readonly<Record<string, unknown>>);
      if (err) return `[${i}]: ${err}`;
    }
  }
  return undefined;
}

/** Parse the loop's final text against the optional schema. Returns the
 *  parsed output (validated) plus a violation message when it fails. */
export function parseAndValidate(
  result: Awaited<ReturnType<OmaSession["startLoop"]>>,
  schema: SubagentSpec["schema"],
): { text: string; output?: unknown; parseError?: string } {
  const text = (result.messages?.at(-1)?.text ?? "").trim();
  if (!schema || !text) return { text };
  try {
    const parsed = JSON.parse(text) as unknown;
    const schemaError = validateJsonSchema(parsed, schema);
    if (schemaError) return { text, parseError: `schema validation failed: ${schemaError}` };
    return { text, output: parsed };
  } catch {
    return { text, parseError: `schema output is not valid JSON: ${text.slice(0, 120)}` };
  }
}

/** A3: keep fan-in results small enough to re-inject into the main loop.
 *  Long item texts spill to `.oma/workflow/<batchId>/<agentId>.result.md`
 *  (the main session reads them back with the read tool); read_only
 *  workspaces degrade to inline truncation. The total-inline budget forces
 *  spill even when no single item exceeds the per-item ceiling. */
export function spillResults(
  results: readonly SubagentResult[],
  batchId: string,
  opts: { workspaceRoot: string; workspaceAccess: "read_only" | "read_write" },
): SubagentResult[] {
  const total = results.reduce((acc, r) => acc + r.text.length, 0);
  const forceSpill = total > MAX_TOTAL_INLINE_CHARS;
  return results.map((r, i) => {
    if (!forceSpill && r.text.length <= MAX_INLINE_ITEM_CHARS) return r;
    const excerpt = r.text.slice(0, EXCERPT_CHARS);
    if (opts.workspaceAccess !== "read_write") {
      return { ...r, text: `${excerpt}…[truncated]` };
    }
    const rel = `.oma/workflow/${batchId}/a${i}.result.md`;
    const abs = join(opts.workspaceRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, r.text);
    return { ...r, text: excerpt, resultPath: rel };
  });
}
