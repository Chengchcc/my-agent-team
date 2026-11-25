/** The tool catalog as the page shows it. `inputSchema` is kept verbatim for the JSON view;
 *  `parameters` is the table derived from it. A call's outcome is shaped here too, so a failure is
 *  always a failure wherever it came from. */

export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

export interface ToolParameter {
  name: string;
  /** The schema's `type`, or "—" when the schema does not say. */
  type: string;
  required: boolean;
  description: string;
}

export interface CatalogTool {
  name: string;
  description: string;
  inputSchema: JsonSchema | null;
  parameters: ToolParameter[];
}

export interface ToolCatalog {
  /** The connection status the tools endpoint returned alongside the list. */
  status: string;
  latencyMs: number | null;
  schemaHash: string | null;
  tools: CatalogTool[];
}

export interface ToolCallOutcome {
  ok: boolean;
  /** The tool's text, the error it reported, or the raw result as JSON. */
  text: string;
}

export type ConnectionState = "never tested" | "connecting" | "connected" | "failed";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  return "";
}

function schemaType(schema: Record<string, unknown>): string {
  const type = schema.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) return type.map(String).join(" | ");
  return "—";
}

/** One row per property, in the schema's order. `required` is the schema's own list. */
export function toolParameters(inputSchema: Record<string, unknown> | null): ToolParameter[] {
  if (inputSchema === null) return [];
  const properties = asRecord(inputSchema.properties);
  if (properties === null) return [];
  const rawRequired = Array.isArray(inputSchema.required) ? inputSchema.required : [];
  const required = rawRequired.map(String);
  const parameters: ToolParameter[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const schema = asRecord(raw);
    parameters.push({
      name,
      type: schema === null ? "—" : schemaType(schema),
      required: required.includes(name),
      description: schema === null ? "" : text(schema.description),
    });
  }
  return parameters;
}

/** The tools endpoint's body, with anything missing filled in as "not there" rather than guessed. */
export function shapeToolCatalog(raw: unknown): ToolCatalog {
  const record = asRecord(raw);
  if (record === null) {
    return { status: "unknown", latencyMs: null, schemaHash: null, tools: [] };
  }
  const rawTools = Array.isArray(record.tools) ? record.tools : [];
  const tools: CatalogTool[] = [];
  for (const item of rawTools) {
    const tool = asRecord(item);
    if (tool === null) continue;
    const name = text(tool.name);
    if (name === "") continue;
    const inputSchema = asRecord(tool.inputSchema);
    tools.push({
      name,
      description: text(tool.description),
      inputSchema,
      parameters: toolParameters(inputSchema),
    });
  }
  const status = typeof record.status === "string" ? record.status : "unknown";
  const latencyMs = typeof record.latencyMs === "number" ? record.latencyMs : null;
  const schemaHash = typeof record.schemaHash === "string" ? record.schemaHash : null;
  return { status, latencyMs, schemaHash, tools };
}

function resultText(result: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      const block = asRecord(item);
      if (block !== null && typeof block.text === "string") parts.push(block.text);
    }
  }
  if (parts.length > 0) return parts.join("\n");
  return JSON.stringify(result, null, 2);
}

/** A call failed when the request itself failed or the tool answered with `isError`. It is
 *  returned as a failure then, never as a success with odd text. */
export function shapeToolCall(raw: unknown): ToolCallOutcome {
  const record = asRecord(raw);
  if (record === null) {
    return { ok: false, text: "No result" };
  }
  const error = text(record.error);
  if (error !== "") return { ok: false, text: error };
  const result = asRecord(record.result);
  if (result === null) {
    return { ok: false, text: JSON.stringify(record.result ?? null, null, 2) };
  }
  if (result.isError === true) return { ok: false, text: resultText(result) };
  return { ok: true, text: resultText(result) };
}

/** What the catalog's `status` field says. Absent means no connection was ever attempted by
 *  this process; it is not a failure and not a success. */
export function connectionState(status: string | null | undefined): ConnectionState {
  if (status === undefined || status === null) return "never tested";
  if (status === "connected") return "connected";
  if (status === "pending") return "connecting";
  return "failed";
}
