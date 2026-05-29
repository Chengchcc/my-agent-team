import { describe, it, expect } from 'bun:test'

const CHAT_PURPOSE_PREFIXES = ['subagent.run.']

function isChatPurposeAllowed(purpose: string): boolean {
  return CHAT_PURPOSE_PREFIXES.some(p => purpose.startsWith(p))
}

describe('CHAT_PURPOSE_WHITELIST', () => {
  it('allows subagent.run.explore', () => {
    expect(isChatPurposeAllowed('subagent.run.explore')).toBe(true)
  })

  it('allows subagent.run.plan', () => {
    expect(isChatPurposeAllowed('subagent.run.plan')).toBe(true)
  })

  it('allows subagent.run.general-purpose', () => {
    expect(isChatPurposeAllowed('subagent.run.general-purpose')).toBe(true)
  })

  it('allows extension-registered sub-agent type via prefix', () => {
    expect(isChatPurposeAllowed('subagent.run.custom-reviewer')).toBe(true)
  })

  it('denies evolution.review.tier0 (invoke-only purpose)', () => {
    expect(isChatPurposeAllowed('evolution.review.tier0')).toBe(false)
  })

  it('denies memory.extract (invoke-only purpose)', () => {
    expect(isChatPurposeAllowed('memory.extract')).toBe(false)
  })

  it('denies empty purpose', () => {
    expect(isChatPurposeAllowed('')).toBe(false)
  })

  it('allows subagent.run. with empty suffix', () => {
    expect(isChatPurposeAllowed('subagent.run.')).toBe(true)
  })
})

function isToolAllowed(toolName: string, allowedToolNames: readonly string[]): boolean {
  return allowedToolNames.includes(toolName)
}

describe('Tool dispatch whitelist', () => {
  const exploreTools = ['read', 'grep', 'glob', 'ls', 'web_search', 'web_fetch']

  it('allows read for explore', () => {
    expect(isToolAllowed('read', exploreTools)).toBe(true)
  })

  it('denies bash for explore', () => {
    expect(isToolAllowed('bash', exploreTools)).toBe(false)
  })

  it('denies task for all (recursive guard)', () => {
    expect(isToolAllowed('task', exploreTools)).toBe(false)
  })

  it('denies empty tool name', () => {
    expect(isToolAllowed('', exploreTools)).toBe(false)
  })
})
