import { describe, it, expect } from 'bun:test'
import { injectRecall, injectIdentity, stripEphemeral } from '../../../src/application/usecases/transform-prompt'
import type { Prompt } from '../../../src/application/usecases/transform-prompt'

describe('TransformPrompt usecase', () => {
  const basePrompt: Prompt = {
    system: 'You are a helpful assistant.',
    messages: [
      { role: 'user', content: 'hello' },
    ],
  }

  describe('injectRecall', () => {
    it('adds recall section', () => {
      const memories = [
        { text: 'User prefers TypeScript', weight: 0.95 },
        { text: 'Project uses Bun runtime', weight: 0.8 },
      ]

      const result = injectRecall({ ...basePrompt, system: basePrompt.system }, memories)

      expect(result.system).toContain('<!-- recall -->')
      expect(result.system).toContain('<!-- /recall -->')
      expect(result.system).toContain('User prefers TypeScript')
      expect(result.system).toContain('Project uses Bun runtime')
      expect(result.system).toContain('[weight=0.95]')
      expect(result.system).toContain('[weight=0.80]')
      expect(result.system).toStartWith('You are a helpful assistant.')
      expect(result.messages).toEqual(basePrompt.messages)
    })

    it('returns prompt unchanged when no memories', () => {
      const result = injectRecall(basePrompt, [])
      expect(result).toEqual(basePrompt)
    })
  })

  describe('injectIdentity', () => {
    it('adds identity section', () => {
      const identity = {
        name: 'Alice',
        role: 'developer',
      }

      const result = injectIdentity({ ...basePrompt, system: basePrompt.system }, identity)

      expect(result.system).toContain('<!-- identity -->')
      expect(result.system).toContain('<!-- /identity -->')
      expect(result.system).toContain('- name: Alice')
      expect(result.system).toContain('- role: developer')
      expect(result.system).toStartWith('You are a helpful assistant.')
    })

    it('returns prompt unchanged when identity is empty', () => {
      const result = injectIdentity(basePrompt, {})
      expect(result).toEqual(basePrompt)
    })
  })

  describe('stripEphemeral', () => {
    it('removes ephemeral blocks', () => {
      const promptWithEphemeral: Prompt = {
        system: 'Base system.\n<!-- recall -->\n- memory 1\n<!-- /recall -->\n<!-- identity -->\n- name: Alice\n<!-- /identity -->\nEnd.',
        messages: [],
      }

      const result = stripEphemeral(promptWithEphemeral)

      expect(result.system).not.toContain('<!-- recall -->')
      expect(result.system).not.toContain('<!-- /recall -->')
      expect(result.system).not.toContain('<!-- identity -->')
      expect(result.system).not.toContain('<!-- /identity -->')
      expect(result.system).not.toContain('memory 1')
      expect(result.system).not.toContain('name: Alice')
      expect(result.system).toBe('Base system.\nEnd.')
    })

    it('returns prompt unchanged when no ephemeral blocks', () => {
      const cleanPrompt: Prompt = {
        system: 'No blocks here.',
        messages: [],
      }

      const result = stripEphemeral(cleanPrompt)
      expect(result).toEqual(cleanPrompt)
    })
  })
})
