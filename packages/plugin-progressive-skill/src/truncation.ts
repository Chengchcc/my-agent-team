export function truncateAtParagraph(
  text: string,
  maxChars: number,
  lookahead: number,
): { content: string; nextOffset?: number } {
  if (text.length <= maxChars) return { content: text };

  const hardEnd = Math.min(text.length, maxChars);
  const lookaheadEnd = Math.min(text.length, hardEnd + lookahead);
  const tail = text.slice(hardEnd, lookaheadEnd);
  const breakIdx = tail.indexOf("\n\n");

  const realEnd = breakIdx >= 0 ? hardEnd + breakIdx : hardEnd;
  const content = text.slice(0, realEnd);
  const hasMore = realEnd < text.length;

  return {
    content,
    nextOffset: hasMore ? realEnd : undefined,
  };
}
