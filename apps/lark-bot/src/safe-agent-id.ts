import { createHash } from "node:crypto";

/** Replace non-[a-zA-Z0-9_-] chars with _ for filesystem/profile safety.
 *  Appends short hash suffix to avoid collision when different raw IDs
 *  map to the same sanitized slug (e.g. "foo.bar" and "foo_bar"). */
export function safeAgentId(raw: string): string {
  const slug = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}
