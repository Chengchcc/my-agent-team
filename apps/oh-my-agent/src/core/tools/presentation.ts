/**
 * The single place that sanitizes a user-visible tool activity line.
 *
 * Tools describe what they are doing (`Tool.describeStart`); this function
 * makes that description safe to cross the process boundary and reach every
 * surface. It is deliberately NOT a generic input formatter — a tool knows
 * which part of its input is meaningful (read wants the path, bash wants the
 * command), so the tool picks, and this only enforces the invariants that
 * hold for all of them.
 */

const MAX_LENGTH = 160;

/** Drop ANSI escape sequences by code point.
 *
 *  Not a regex on purpose: the pattern needs ESC(0x1B) and BEL(0x07), and both
 *  linters reject control characters in a pattern (biome's
 *  `noControlCharactersInRegex`, eslint's `no-control-regex`) — a literal trips
 *  one, a constructed RegExp trips the other. The grammar is small enough to
 *  walk: CSI consumes params up to a final byte, OSC up to BEL or ST, and any
 *  other ESC drops two characters. */
function stripAnsi(text: string): string {
  const ESC = 27;
  const BEL = 7;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== ESC) {
      out += text[i];
      continue;
    }
    const kind = text.charCodeAt(i + 1);
    if (kind === 0x5b) {
      // CSI: params until a final byte in 0x40–0x7E.
      i += 2;
      while (i < text.length) {
        const c = text.charCodeAt(i);
        if (c >= 0x40 && c <= 0x7e) break;
        i++;
      }
      continue;
    }
    if (kind === 0x5d) {
      // OSC: payload until BEL or ST (ESC \).
      i += 2;
      while (i < text.length) {
        const c = text.charCodeAt(i);
        if (c === BEL) break;
        if (c === ESC && text.charCodeAt(i + 1) === 0x5c) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Any other escape: drop ESC and the byte it introduced.
    i++;
  }
  return out;
}

/** Drop C0/C1 control characters, turning line breaks and tabs into a space
 *  so words never run together. Written as a code-point filter rather than a
 *  character class for the same reason as the ANSI walk above. */
const WHITESPACE_CONTROLS = new Set([9, 10, 11, 12, 13]);

function stripControl(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (WHITESPACE_CONTROLS.has(code)) out += " ";
    else if (code >= 32 && (code < 127 || code > 159)) out += ch;
  }
  return out;
}

/** Obvious credentials. Order matters: the specific forms run first so a
 *  token inside a URL/header is redacted as a token, not as a whole URL. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:gh[pousr]|sk|pk|xox[baprs])[-_][A-Za-z0-9_-]{16,}/g, // gh&_/sk-…/xoxb-…
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, // Authorization: Bearer …
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, // Authorization: Basic <base64>
  /-u\s+[^\s:]+:[^\s]+/gi, // curl -u user:pass (needs the colon: plain `sort -u x` stays readable)
  /--user\s+\S+/gi, // curl --user credentials
  /\b(?:api[-_]?key|access[-_]?token|secret|password|passwd|pwd)\b\s*[=:]\s*\S{6,}/gi,
  /\/\/[^/@\s]+:[^/@\s]+@/g, // scheme://user:pass@host
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key id
];

/** Collapse to one line, strip escapes, redact, truncate, fall back. */
export function safeToolSummary(text: string | undefined, fallback: string): string {
  if (typeof text !== "string") return fallback;
  let out = stripControl(stripAnsi(text)).replace(/\s+/g, " ").trim();
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[已隐藏]");
  if (out.length > MAX_LENGTH) out = `${out.slice(0, MAX_LENGTH - 1)}…`;
  return out.length === 0 ? fallback : out;
}

/** Read one string field off an unknown tool input. Tool inputs arrive as
 *  `unknown` (they were model-authored JSON), so every `describeStart`
 *  needs this narrow read; keeping it here avoids six copies of the same
 *  type guard in the tool files. */
export function readStringField(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
