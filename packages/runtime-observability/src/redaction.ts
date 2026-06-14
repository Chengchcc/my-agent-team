import type { RuntimeSpanAttributes } from "./types.js";

const REDACTED_ATTRIBUTE_KEYS = new Set([
  "message.text",
  "tool.input",
  "lark.chat_id",
  "lark.open_id",
  "profile.secret",
  "api.key",
]);

export function redactAttributes(
  attrs: RuntimeSpanAttributes,
): RuntimeSpanAttributes {
  const result: RuntimeSpanAttributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (REDACTED_ATTRIBUTE_KEYS.has(key)) continue;
    (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

export function isRedactedKey(key: string): boolean {
  return REDACTED_ATTRIBUTE_KEYS.has(key);
}
