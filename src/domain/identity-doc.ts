export interface ParsedIdentity {
  frontMatter: Record<string, string>
  body: string
}

export function parseIdentityMarkdown(md: string): ParsedIdentity {
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!fmMatch) return { frontMatter: {}, body: md.trim() }

  const fmText = fmMatch[1]
  if (!fmText) return { frontMatter: {}, body: md.trim() }

  const body = md.slice(fmMatch[0].length).trim()
  const frontMatter: Record<string, string> = {}

  const lines = fmText.split('\n')
  let currentKey = ''
  let inArray = false

  for (const line of lines) {
    const keyVal = line.match(/^(\w[\w_-]*):\s*(.*)/)
    if (keyVal && keyVal[1] !== undefined && keyVal[2] !== undefined) {
      currentKey = keyVal[1]
      const val = keyVal[2].trim()
      if (val === '' || val === '[' || val.startsWith('-')) {
        inArray = true
        if (val.startsWith('-')) {
          frontMatter[currentKey] = val.replace(/^-\s*/, '')
        }
      } else {
        inArray = false
        frontMatter[currentKey] = val
      }
    } else if (inArray) {
      const item = line.trim().replace(/^-\s*/, '')
      if (item) {
        frontMatter[currentKey] = frontMatter[currentKey]
          ? frontMatter[currentKey] + ', ' + item
          : item
      }
    }
  }

  return { frontMatter, body }
}

export function renderIdentityMd(fields: Record<string, string>, body: string): string {
  const fmLines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`)
  return `---\n${fmLines.join('\n')}\n---\n\n${body}`
}
