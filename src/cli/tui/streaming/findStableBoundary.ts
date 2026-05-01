/**
 * Find the largest index b such that s.slice(0, b) will never change its
 * markdown parse structure no matter what characters are appended later.
 *
 * Returns a boundary in [0, s.length] and a committable flag indicating
 * whether the stable portion contains at least one complete block-level
 * element (heading, paragraph, closed fence, list item, or table row).
 */
export interface StableResult {
  boundary: number;
  committable: boolean;
}

export function findStableBoundary(s: string): StableResult {
  if (!s) return { boundary: 0, committable: false };

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
  if (para >= 0) {
    const boundary = para + 2;
    return { boundary, committable: hasCompleteBlock(s.slice(0, boundary)) };
  }

  // Fallback: last single newline whose preceding line is inline-stable
  const nl = findLastSafeNewline(clipped);
  if (nl >= 0) {
    const boundary = nl + 1;
    return { boundary, committable: hasCompleteBlock(s.slice(0, boundary)) };
  }

  // Last resort: nothing is stable
  return { boundary: 0, committable: false };
}

// ── Block completeness check ──

function hasCompleteBlock(s: string): boolean {
  if (!s.trim()) return false;
  // A complete heading
  if (/^#{1,6}\s+\S/m.test(s)) return true;
  // A closed fenced code block
  if (/```[\s\S]*?```/.test(s) || /~~~[\s\S]*?~~~/.test(s)) return true;
  // A paragraph (non-empty line followed by blank line or end)
  if (/\S.*\S/.test(s) && s.endsWith('\n\n')) return true;
  // A list item (line starting with - * or 1.)
  if (/^\s*[-*]\s+\S/m.test(s) || /^\s*\d+\.\s+\S/m.test(s)) return true;
  return false;
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
  const backticks = (line.match(/`+/g) ?? []).map(m => m.length);
  let tickOpen = false;
  for (const n of backticks) {
    if (n % 2 !== 0) tickOpen = !tickOpen;
  }
  if (tickOpen) return false;

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

  if (line.endsWith('\\') && !line.endsWith('\\\\')) return false;

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
  if (/^\s*\|?[-:\s|]+\|?\s*$/.test(line)) return false;
  const nextStart = nl + 1;
  const nextEnd = s.indexOf('\n', nextStart);
  if (nextEnd < 0) return true;
  const nextLine = s.slice(nextStart, nextEnd);
  return !/^\s*\|?[-:\s|]+\|?\s*$/.test(nextLine);
}
