import { describe, it, expect } from 'bun:test'
import { truncateOutput, TRUNCATION_MARKER_PREFIX } from '../../../src/extensions/tools/truncation'

describe('outputCap truncation', () => {
  it('returns content unchanged when under outputCap', () => {
    const content = 'hello world'
    const result = truncateOutput(content, 1024)
    expect(result).toBe(content)
  })

  it('truncates content exceeding outputCap and adds marker', () => {
    const content = 'x'.repeat(5000)
    const result = truncateOutput(content, 100)
    expect(result).toContain(TRUNCATION_MARKER_PREFIX)
    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(100)
  })

  it('marker includes original byte count', () => {
    const content = 'x'.repeat(500)
    const originalBytes = Buffer.byteLength(content, 'utf-8')
    const result = truncateOutput(content, 50)
    expect(result).toContain(`bytes=${originalBytes}`)
  })

  it('truncated content does not split multi-byte characters', () => {
    const content = '\u4F60\u597D\u4E16\u754C'.repeat(100)
    const result = truncateOutput(content, 50)
    expect(result).not.toContain('\uFFFD')
    expect(result).toContain(TRUNCATION_MARKER_PREFIX)
  })

  it('empty content returns empty', () => {
    const result = truncateOutput('', 100)
    expect(result).toBe('')
  })

  it('zero outputCap still produces valid marker', () => {
    const result = truncateOutput('hello', 1)
    expect(result).toContain(TRUNCATION_MARKER_PREFIX)
  })

  it('extra fields are included in marker', () => {
    const content = 'x'.repeat(1000)
    const result = truncateOutput(content, 50, { exit: 0 })
    expect(result).toContain('exit=0')
    expect(result).toContain('bytes=')
  })
})
