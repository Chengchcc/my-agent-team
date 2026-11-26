import type { NewServerSettings, ServerSettings } from "./mutations";
import type { McpCatalogRow } from "./queries";

/** The connection form's text, as the person typed it. In edit mode `env` and `headers` start
 *  empty and are filled only from the keyboard: the server's answer is masked (`****1234`), and
 *  sending that back would replace the real value with the mask. */
export interface ServerForm {
  name: string;
  transport: "stdio" | "sse";
  command: string;
  args: string;
  env: string;
  headers: string;
  url: string;
  /** The bulk import tab's JSON; add mode only. */
  json: string;
}

export const EMPTY_FORM: ServerForm = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  env: "",
  headers: "",
  url: "",
  json: "",
};

/** The fields a form is prefilled from. Secrets are deliberately not part of this type, so a
 *  form cannot be built from them. */
export type ServerSource = Pick<McpCatalogRow, "name" | "transport" | "command" | "args" | "url">;

export function formFromServer(server: ServerSource): ServerForm {
  return {
    name: server.name,
    transport: server.transport,
    command: server.command ?? "",
    args: (server.args ?? []).join(" "),
    env: "",
    headers: "",
    url: server.url ?? "",
    json: "",
  };
}

/** `KEY=VALUE` lines. A line without `=`, an empty key, or a value that is the server's mask
 *  makes the whole block invalid rather than silently dropping or saving the wrong thing. */
export function parsePairs(raw: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const idx = line.indexOf("=");
    if (idx <= 0) return null;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === "" || value.startsWith("****")) return null;
    out[key] = value;
  }
  return out;
}

export function parseArgs(raw: string): string[] {
  return raw.split(/\s+/).filter((part) => part !== "");
}

/** The secrets to send, and nothing else: a map leaves only when something was typed, and
 *  the backend then replaces the whole stored map. */
export function secretsToSave(
  form: ServerForm,
): { ok: true; env?: Record<string, string>; headers?: Record<string, string> } | { ok: false } {
  let env: Record<string, string> | undefined;
  let headers: Record<string, string> | undefined;
  if (form.env.trim() !== "") {
    const parsed = parsePairs(form.env);
    if (parsed === null) return { ok: false };
    env = parsed;
  }
  if (form.headers.trim() !== "") {
    const parsed = parsePairs(form.headers);
    if (parsed === null) return { ok: false };
    headers = parsed;
  }
  if (env === undefined && headers === undefined) return { ok: true };
  return { ok: true, env, headers };
}

/** An edit's body. It carries no field the person left alone. */
export function updateSettingsFrom(
  form: ServerForm,
): { ok: true; settings: ServerSettings } | { ok: false } {
  const secrets = secretsToSave(form);
  if (!secrets.ok) return { ok: false };
  const settings: ServerSettings = { name: form.name.trim() };
  const command = form.command.trim();
  const url = form.url.trim();
  if (command !== "") settings.command = command;
  if (url !== "") settings.url = url;
  if (form.transport === "stdio") settings.args = parseArgs(form.args);
  if (secrets.env !== undefined) settings.env = secrets.env;
  if (secrets.headers !== undefined) settings.headers = secrets.headers;
  return { ok: true, settings };
}

export function createSettingsFrom(
  form: ServerForm,
): { ok: true; settings: NewServerSettings } | { ok: false } {
  const updated = updateSettingsFrom(form);
  if (!updated.ok) return { ok: false };
  return { ok: true, settings: { ...updated.settings, transport: form.transport } };
}

/** The bulk import tab: one object, or `{ "mcpServers": { name: {...} } }` as the common
 *  client configs are written. Anything invalid throws; nothing is guessed. */
export function serversFromJson(raw: string): NewServerSettings[] {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid JSON");
  }
  const obj = parsed as Record<string, unknown>;
  const wrap: unknown = obj.mcpServers;
  const isWrap =
    typeof wrap === "object" &&
    wrap !== null &&
    !Array.isArray(wrap) &&
    Object.keys(wrap).length > 0;
  const entries: Array<[string, unknown]> = isWrap
    ? Object.entries(wrap as Record<string, unknown>)
    : [["", obj]];
  return entries.map(([key, value]) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Invalid JSON");
    }
    const s = value as Record<string, unknown>;
    const name = key !== "" ? key : typeof s.name === "string" ? s.name : "";
    if (name === "") throw new Error("Invalid JSON");
    const kind: unknown = s.transport ?? s.type;
    const transport = kind === "sse" ? "sse" : "stdio";
    const settings: NewServerSettings = { name, transport };
    if (typeof s.command === "string") settings.command = s.command;
    if (Array.isArray(s.args)) settings.args = s.args.map(String);
    if (typeof s.url === "string") settings.url = s.url;
    if (typeof s.env === "object" && s.env !== null && !Array.isArray(s.env)) {
      settings.env = stringMap(s.env as Record<string, unknown>);
    }
    if (typeof s.headers === "object" && s.headers !== null && !Array.isArray(s.headers)) {
      settings.headers = stringMap(s.headers as Record<string, unknown>);
    }
    return settings;
  });
}

function stringMap(record: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = String(value);
  }
  return out;
}
