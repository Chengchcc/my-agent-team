/** The Raw JSON view of Settings: the real `GET /api/settings` document,
 *  edited as text and checked against what the product actually reads.
 *
 *  Pure. The document is `{ "settings": { ... } }`; a candidate is accepted
 *  only when every key it adds or changes is one the product reads, typed the
 *  way the product reads it, and not a credential. Nothing here writes: the
 *  page saves the accepted changes one per-key PUT at a time, after a confirm. */
import { t } from "@/lib/i18n";

export type SettingsMap = Record<string, unknown>;

export interface SettingSpec {
  readonly key: string;
  /** What the person knows it as. */
  readonly label: string;
  /** Why the value is wrong for the way the product reads it, or null. */
  readonly check: (value: unknown) => string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ASSESSMENT_MODES = ["off", "observe", "auto"];

/** Every key the product reads from the settings store, and how it reads it.
 *  Keep in step with the backend: `budget-gate.ts`, `bootstrap/features.ts`
 *  (dispatch, assessment gate, sandbox allowlist) and the two web sections. */
export const SETTING_SPECS: readonly SettingSpec[] = [
  {
    key: "dispatch.reuseChildConversation",
    label: "Reuse the worker's room across dispatches",
    check: (value) => (typeof value === "boolean" ? null : "must be true or false"),
  },
  {
    key: "proactiveAssessment",
    label: "Semantic assessment gate",
    check: (value) => {
      if (!isPlainObject(value)) return "must be an object";
      for (const name of Object.keys(value)) {
        if (name !== "mode" && name !== "model") return `has an unknown field "${name}"`;
      }
      const mode = value.mode;
      if (mode !== undefined) {
        const modeOk = typeof mode === "string" && ASSESSMENT_MODES.includes(mode);
        if (!modeOk) return "mode must be off, observe or auto";
      }
      if (value.model !== undefined && typeof value.model !== "string") {
        return "model must be a string";
      }
      return null;
    },
  },
  {
    key: "cost.dailyBudgetUsd",
    label: "Daily budget in USD; no new runs start past it",
    check: (value) => {
      const amount = typeof value === "number" && Number.isFinite(value) && value > 0;
      return amount ? null : "must be a number greater than 0";
    },
  },
  {
    key: "sandbox.networkAllowlist",
    label: "Hosts sandboxed runs may reach; read at startup",
    check: (value) => {
      const hosts = Array.isArray(value);
      if (!hosts) return "must be a list of host names";
      const allNamed = value.every((host) => typeof host === "string" && host.trim() !== "");
      return allNamed ? null : "must be a list of non-empty host names";
    },
  },
];

const SPEC_BY_KEY = new Map(SETTING_SPECS.map((spec) => [spec.key, spec]));

/** The same test the settings route applies before refusing a key. */
export function isSecretKeyName(key: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD/i.test(key);
}

/** Keys another part of the product owns. They may stay in the document as
 *  they are (a masked value put back would overwrite the real one), but the
 *  Raw JSON view never changes them. */
const MANAGED: readonly { where: string; owns: (key: string) => boolean }[] = [
  { where: "Models & credentials", owns: (key) => key.startsWith("provider.") },
  { where: "Models & credentials", owns: (key) => key === "providerEnv" },
  { where: "the password and credential forms", owns: isSecretKeyName },
];

/** A credential pasted as a value. No setting here takes one, so any string
 *  shaped like a key is refused. */
const SECRET_SHAPES = [
  /^sk-[A-Za-z0-9_-]{12,}$/,
  /^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}$/,
  /^xox[baprs]-[A-Za-z0-9-]{8,}$/,
  /^AKIA[0-9A-Z]{16}$/,
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^(Bearer|Basic) [A-Za-z0-9._~+/=-]{16,}$/,
];

export function looksLikeSecret(value: unknown): boolean {
  return typeof value === "string" && SECRET_SHAPES.some((shape) => shape.test(value.trim()));
}

function holdsSecret(value: unknown): boolean {
  if (looksLikeSecret(value)) return true;
  if (Array.isArray(value)) return value.some(holdsSecret);
  if (isPlainObject(value)) return Object.values(value).some(holdsSecret);
  return false;
}

export type ReasonCode =
  | "syntax"
  | "envelope"
  | "unknown"
  | "managed"
  | "missing"
  | "type"
  | "secret";

export interface SettingsReason {
  readonly code: ReasonCode;
  readonly key?: string;
  readonly detail?: string;
  readonly where?: string;
}

export type ParsedDocument =
  | { readonly ok: true; readonly settings: SettingsMap }
  | { readonly ok: false; readonly reasons: readonly SettingsReason[] };

/** The text in the editor → the settings object, or why it cannot be one. */
export function parseSettingsDocument(raw: string): ParsedDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reasons: [{ code: "syntax", detail }] };
  }
  const onlySettings = isPlainObject(parsed) && Object.keys(parsed).length === 1;
  const body = isPlainObject(parsed) ? parsed.settings : undefined;
  if (!onlySettings || !isPlainObject(body)) return { ok: false, reasons: [{ code: "envelope" }] };
  return { ok: true, settings: body };
}

export interface SettingsChange {
  readonly key: string;
  readonly label: string;
  /** The stored value, compact; "not set" when the key has none. */
  readonly from: string;
  readonly to: string;
  /** The value to PUT. */
  readonly value: unknown;
}

export type Validation =
  | {
      readonly ok: true;
      readonly changes: readonly SettingsChange[];
      /** Keys in the document this view leaves exactly as stored. */
      readonly untouched: readonly string[];
    }
  | { readonly ok: false; readonly reasons: readonly SettingsReason[] };

function formatValue(value: unknown): string {
  if (value === undefined) return "not set";
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/** The candidate against the stored document: what would change, or why
 *  nothing may be saved. Keys the candidate leaves out and the document never
 *  had are not a change; keys it leaves out that were stored are, because
 *  there is no way to delete one. */
export function validateSettings(candidate: SettingsMap, current: SettingsMap): Validation {
  const reasons: SettingsReason[] = [];
  const changes: SettingsChange[] = [];
  const untouched: string[] = [];

  for (const [key, value] of Object.entries(candidate)) {
    const stored = Object.hasOwn(current, key) ? current[key] : undefined;
    const same = JSON.stringify(value) === JSON.stringify(stored);
    const spec = SPEC_BY_KEY.get(key);
    if (spec === undefined) {
      // Stored by another channel, or by nothing: either way not this view's
      // to change. Left as it is, it is simply not touched.
      if (same) {
        untouched.push(key);
        continue;
      }
      const owner = MANAGED.find((entry) => entry.owns(key));
      const code: ReasonCode = owner === undefined ? "unknown" : "managed";
      reasons.push({ code, key, where: owner?.where });
      continue;
    }
    if (same) continue;
    const wrong = spec.check(value);
    if (wrong !== null) {
      reasons.push({ code: "type", key, detail: wrong });
      continue;
    }
    if (holdsSecret(value)) {
      reasons.push({ code: "secret", key });
      continue;
    }
    changes.push({
      key,
      label: spec.label,
      from: formatValue(stored),
      to: formatValue(value),
      value,
    });
  }

  for (const key of Object.keys(current)) {
    if (Object.hasOwn(candidate, key)) continue;
    if (SPEC_BY_KEY.has(key)) reasons.push({ code: "missing", key });
    else untouched.push(key);
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, changes, untouched };
}

/** A reason as the person reads it. */
export function reasonText(reason: SettingsReason): string {
  const key = reason.key ?? "";
  switch (reason.code) {
    case "syntax":
      return t("Not valid JSON: {detail}", { detail: reason.detail ?? "" });
    case "envelope":
      return t('The document must be one object with a single "settings" key holding an object.');
    case "unknown":
      return t("{key} is not a setting this product reads or writes.", { key });
    case "managed":
      return t("{key} is managed by {where}; change it there.", {
        key,
        where: reason.where ?? "",
      });
    case "missing":
      return t(
        "{key} is missing. The settings API cannot delete a key, so it would keep its stored value.",
        { key },
      );
    case "type":
      return t("{key}: {detail}", { key, detail: t(reason.detail ?? "") });
    case "secret":
      return t(
        "{key}: a plain secret is not accepted here. Credentials go to Models & credentials.",
        { key },
      );
  }
}
