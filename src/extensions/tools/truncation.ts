export const TRUNCATION_MARKER_PREFIX = '<truncated'

/**
 * Truncate output to fit within outputCap bytes, appending a marker
 * with the original byte count. Respects UTF-8 multi-byte boundaries.
 */
export function truncateOutput(
  content: string,
  outputCap: number,
  extra?: Record<string, number>,
): string {
  const totalBytes = Buffer.byteLength(content, 'utf-8')
  if (totalBytes <= outputCap) return content

  const extraEntries = Object.entries(extra ?? {})
  const attrParts = [`bytes=${totalBytes}`, ...extraEntries.map(([k, v]) => `${k}=${v}`)]
  const extraStr = ` ${attrParts.join(' ')}/>`
  const marker = `${TRUNCATION_MARKER_PREFIX}${extraStr}`
  const markerBytes = Buffer.byteLength('\n' + marker, 'utf-8')
  const maxContentBytes = Math.max(1, outputCap - markerBytes)

  let truncated = ''
  let byteCount = 0
  for (const char of content) {
    const charBytes = Buffer.byteLength(char, 'utf-8')
    if (byteCount + charBytes > maxContentBytes) break
    truncated += char
    byteCount += charBytes
  }

  return truncated + '\n' + marker
}
