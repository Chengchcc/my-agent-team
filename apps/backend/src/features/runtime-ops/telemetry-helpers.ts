import type { Message } from "@chengchenccc/message";

export interface WaitInterval {
  readonly actionId: string;
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  readonly owner: string | null;
}

export interface ToolPayloadSnapshot {
  readonly input?: string;
  readonly output?: string;
  readonly isError?: boolean;
}

export interface ActivatedSkill {
  readonly skillName: string;
  readonly path: string;
}

/** Nearest-rank percentile over a non-empty numeric array. Returns null when empty. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[rank]!);
}

/** Merge overlapping wait intervals clamped to [runStart, runEnd] and sum total wait ms.
 *  Concurrent pending actions (e.g., two parallel approvals) are merged so wait time
 *  never exceeds wall-clock duration. */
export function computeWaitIntervals(
  actions: ReadonlyArray<{
    actionId: string;
    kind: string;
    createdAt: number;
    resolvedAt: number | null;
    owner: string | null;
  }>,
  runStart: number,
  runEnd: number,
): { intervals: WaitInterval[]; totalWaitMs: number } {
  const clamped: WaitInterval[] = [];
  for (const a of actions) {
    const start = Math.max(runStart, a.createdAt);
    const end = Math.min(runEnd, a.resolvedAt ?? runEnd);
    if (end > start) {
      clamped.push({ actionId: a.actionId, kind: a.kind, start, end, owner: a.owner });
    }
  }
  clamped.sort((a, b) => a.start - b.start);
  let totalWaitMs = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const iv of clamped) {
    if (curStart < 0) {
      curStart = iv.start;
      curEnd = iv.end;
    } else if (iv.start <= curEnd) {
      curEnd = Math.max(curEnd, iv.end);
    } else {
      totalWaitMs += curEnd - curStart;
      curStart = iv.start;
      curEnd = iv.end;
    }
  }
  if (curStart >= 0) totalWaitMs += curEnd - curStart;
  return { intervals: clamped, totalWaitMs };
}

const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|authorization|cookie|credential)/i;
const SECRET_VALUE_RE =
  /(Bearer\s+[A-Za-z0-9._~+/-]{8,}|sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/gi;

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[nested]";
  if (typeof value === "string") {
    return value.replace(SECRET_VALUE_RE, "[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? "[REDACTED]" : sanitizeValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Serialize, redact common secret patterns/keys, and clip to `maxChars`. */
export function redactAndTruncate(value: unknown, maxChars = 2048): string {
  if (value === undefined || value === null) return "";
  let text: string;
  if (typeof value === "string") {
    text = value.replace(SECRET_VALUE_RE, "[REDACTED]");
  } else {
    try {
      text = JSON.stringify(sanitizeValue(value), null, 2);
    } catch {
      text = "[unserializable]";
    }
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[${text.length - maxChars} chars truncated]`;
}

const SKILL_PATH_RE = /(?:^|[/\\])([^/\\]+)[/\\]SKILL\.md$/i;

/** Detect skills read during a run from canonical outcome messages (works across
 *  all ACP harnesses: oma, claude, pi, omp). */
export function extractSkillsFromMessages(
  messages: readonly Message[] | undefined,
): ActivatedSkill[] {
  if (!messages || messages.length === 0) return [];
  const seen = new Map<string, ActivatedSkill>();
  for (const msg of messages) {
    for (const block of msg.blocks ?? []) {
      if (block.type !== "tool_use") continue;
      const input = block.input;
      if (!input || typeof input !== "object") continue;
      const rec = input as Record<string, unknown>;
      const rawPath =
        typeof rec.path === "string"
          ? rec.path
          : typeof rec.file_path === "string"
            ? rec.file_path
            : typeof rec.filePath === "string"
              ? rec.filePath
              : null;
      if (!rawPath) continue;
      const match = SKILL_PATH_RE.exec(rawPath.trim());
      if (!match?.[1]) continue;
      const skillName = match[1];
      if (!seen.has(skillName)) {
        seen.set(skillName, { skillName, path: rawPath.trim() });
      }
    }
  }
  return [...seen.values()];
}

/** Extract sanitized & truncated tool call input/output keyed by callId from
 *  a run's committed terminal outcome (zero live-wire bloat, ADR 0033 safe). */
export function extractToolPayloadsFromOutcome(
  outcome: unknown,
): Record<string, ToolPayloadSnapshot> {
  if (!outcome || typeof outcome !== "object" || !("messages" in outcome)) return {};
  const messages = (outcome as { messages?: readonly Message[] }).messages;
  if (!Array.isArray(messages)) return {};
  const map: Record<string, { input?: string; output?: string; isError?: boolean }> = {};
  for (const msg of messages) {
    for (const block of msg.blocks ?? []) {
      if (block.type === "tool_use" && block.id) {
        const entry = map[block.id] ?? {};
        map[block.id] = entry;
        entry.input = redactAndTruncate(block.input ?? {}, 2048);
      } else if (block.type === "tool_result" && block.tool_use_id) {
        const entry = map[block.tool_use_id] ?? {};
        map[block.tool_use_id] = entry;
        entry.output = redactAndTruncate(block.content, 2048);
        if (block.is_error) entry.isError = true;
      }
    }
  }
  return map;
}
