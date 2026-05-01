/**
 * Find the largest index b such that s.slice(0, b) will never change its
 * markdown parse structure no matter what characters are appended later.
 *
 * Used by streaming markdown to split content into:
 *   stable = s.slice(0, b)  → renderMarkdownTokens (memo-able)
 *   tail   = s.slice(b)     → plain <Text> (always safe)
 *
 * Returns a value in [0, s.length].
 */
export function findStableBoundary(s: string): number {
  if (!s) return 0;

  const len = s.length;
  let inFence = false;
  let fenceStart = -1;
  let inMathBlock = false;
  let mathStart = -1;

  let i = 0;
  let lineStart = 0;

  while (i < len) {
    if (i === lineStart) {
      const fenceMatch = matchFence(s, i);
      if (fenceMatch) {
        if (!inFence) {
          inFence = true;
          fenceStart = lineStart;
        } else {
          inFence = false;
          fenceStart = -1;
        }
        i = skipToLineEnd(s, i);
        lineStart = i + 1;
        i = lineStart;
        continue;
      }

      if (!inFence && s.startsWith('$$', i)) {
        if (!inMathBlock) {
          inMathBlock = true;
          mathStart = lineStart;
        } else {
          inMathBlock = false;
          mathStart = -1;
        }
        i += 2;
        continue;
      }
    }

    if (s[i] === '\n') {
      lineStart = i + 1;
    }
    i++;
  }

  // Shrink maxSafe below any still-open block structure
  let maxSafe = len;
  if (inFence) maxSafe = Math.min(maxSafe, fenceStart);
  if (inMathBlock) maxSafe = Math.min(maxSafe, mathStart);

  const clipped = s.slice(0, maxSafe);

  // Preferred: last paragraph boundary (double newline)
  const para = clipped.lastIndexOf('\n\n');
  if (para >= 0) return para + 2;

  // Fallback: last single newline whose preceding line is inline-stable
  const nl = findLastSafeNewline(clipped);
  if (nl >= 0) return nl + 1;

  // Last resort: nothing is stable, render everything as tail text
  return 0;
}

// ── Helpers ──

const MAX_FENCE_INDENT = 3;
const MIN_FENCE_CHARS = 3;

function matchFence(s: string, i: number): boolean {
  let j = i;
  let sp = 0;
  while (j < s.length && s[j] === ' ' && sp <= MAX_FENCE_INDENT) { j++; sp++; }
  if (sp > MAX_FENCE_INDENT) return false;
  const ch = s[j];
  if (ch !== '`' && ch !== '~') return false;
  let n = 0;
  while (s[j] === ch) { j++; n++; }
  return n >= MIN_FENCE_CHARS;
}

function skipToLineEnd(s: string, i: number): number {
  const nl = s.indexOf('\n', i);
  return nl === -1 ? s.length : nl;
}

function findLastSafeNewline(clipped: string): number {
  let pos = clipped.length;
  while (true) {
    const nl = clipped.lastIndexOf('\n', pos - 1);
    if (nl < 0) return -1;
    const ls = lineStartOf(clipped, nl);
    const line = clipped.slice(ls, nl);
    if (isLineInlineStable(line) && !isPartialTableHeader(clipped, nl)) {
      return nl;
    }
    pos = nl;
  }
}

function lineStartOf(s: string, pos: number): number {
  const p = s.lastIndexOf('\n', pos - 1);
  return p < 0 ? 0 : p + 1;
}

function isLineInlineStable(line: string): boolean {
  // Must have matched backtick pairs
  const backticks = (line.match(/`+/g) ?? []).map(m => m.length);
  let tickOpen = false;
  for (const n of backticks) {
    if (n % 2 !== 0) tickOpen = !tickOpen;
  }
  if (tickOpen) return false;

  // Must have balanced [] and completed (...) URLs
  let bracketDepth = 0;
  let inUrl = false;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    const prev = line[k - 1];
    if (prev === '\\') continue;
    if (!inUrl) {
      if (c === '[') bracketDepth++;
      else if (c === ']') {
        bracketDepth = Math.max(0, bracketDepth - 1);
        if (line[k + 1] === '(') { inUrl = true; k++; }
      }
    } else {
      if (c === ')') inUrl = false;
    }
  }
  if (bracketDepth > 0 || inUrl) return false;

  // Trailing lone backslash
  if (line.endsWith('\\') && !line.endsWith('\\\\')) return false;

  // Unmatched emphasis markers
  if (/[*_~]$/.test(line) && !/\s[*_~]$/.test(line)) {
    const stars = (line.match(/\*+/g) ?? []).map(m => m.length);
    let unmatched = 0;
    for (const n of stars) unmatched += n;
    if (unmatched % 2 !== 0) return false;
  }

  return true;
}

function isPartialTableHeader(s: string, nl: number): boolean {
  const ls = lineStartOf(s, nl);
  const line = s.slice(ls, nl);
  if (!/^\s*\|.*\|\s*$/.test(line)) return false;
  // Alignment rows (e.g. |---|) are not headers themselves; skip them
  if (/^\s*\|?[-:\s|]+\|?\s*$/.test(line)) return false;
  const nextStart = nl + 1;
  const nextEnd = s.indexOf('\n', nextStart);
  if (nextEnd < 0) return true;
  const nextLine = s.slice(nextStart, nextEnd);
  return !/^\s*\|?[-:\s|]+\|?\s*$/.test(nextLine);
}
