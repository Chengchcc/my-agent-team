const MARKER_PREFIX = '\u27EA'; // ⟪ (mathematical left angle bracket)
const MARKER_SUFFIX = '\u27EB'; // ⟫ (mathematical right angle bracket)

export const attachmentMap = new Map<string, string>();

/** Returns a fresh RegExp for matching paste markers. Always use 'g' flag — never reuse across iterations. */
export function createPasteMarkerRe(): RegExp {
  // Use [\w-]+ instead of \w+ because nanoid may generate IDs with hyphens
  return new RegExp(`${MARKER_PREFIX}Paste:([\\w-]+)${MARKER_SUFFIX}`, 'g');
}

/** Returns true if text contains any paste marker. */
export function hasPasteMarkers(text: string): boolean {
  return text.indexOf(MARKER_PREFIX) !== -1;
}

export function resolvePastePlaceholders(text: string): string {
  // Use [\w-]+ instead of \w+ because nanoid may generate IDs with hyphens
  return text.replace(new RegExp(`${MARKER_PREFIX}Paste:([\\w-]+)${MARKER_SUFFIX}`, 'g'), (_match, id) => {
    return attachmentMap.get(id as string) ?? _match;
  });
}

/** Compute display text + cursor offset for paste-folded view. */
export function getFoldedDisplay(text: string, cursorOffset: number): { displayText: string; displayCursorOffset: number; totalPasteLines: number } {
  const markerRe = new RegExp(`${MARKER_PREFIX}Paste:([\\w-]+)${MARKER_SUFFIX}`, 'g');
  let totalPasteLines = 0;
  let result = '';
  let lastEnd = 0;
  let adjustedCursor = cursorOffset;
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(text)) !== null) {
    const id = m[1]!;
    const content = attachmentMap.get(id) ?? '';
    const prefix = text.slice(lastEnd, m.index);
    result += prefix;
    if (cursorOffset > m.index + m[0].length) {
      adjustedCursor -= m[0].length - 1;
    }
    result += '\u27EA⋮\u27EB'; // ⟪⋮⟫ folded marker
    const lineCount = content.split('\n').length;
    totalPasteLines += lineCount;
    if (cursorOffset > m.index && cursorOffset < m.index + m[0].length) {
      adjustedCursor = result.length;
    }
    lastEnd = m.index + m[0].length;
  }
  result += text.slice(lastEnd);
  if (adjustedCursor > result.length) adjustedCursor = result.length;
  return { displayText: result, displayCursorOffset: adjustedCursor, totalPasteLines };
}
