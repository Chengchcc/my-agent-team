import { describe, it, expect } from 'bun:test'
import {
  createSkillDescriptor,
  promoteSkill,
} from '../../src/domain/skill-descriptor'
import type { SkillDescriptor } from '../../src/domain/skill-descriptor'

describe('SkillDescriptor', () => {
  describe('createSkillDescriptor', () => {
    it('should create with defaults: scope=profile, version=1, no promotedFrom', () => {
      const skill = createSkillDescriptor({
        id: 'sk1',
        name: 'My Skill',
        description: 'A test skill',
      })
      expect(skill.id).toBe('sk1')
      expect(skill.name).toBe('My Skill')
      expect(skill.description).toBe('A test skill')
      expect(skill.scope).toBe('agent')
      expect(skill.version).toBe(1)
      expect(skill.promotedFrom).toBeUndefined()
      expect(skill.createdAt).toBeInstanceOf(Date)
      expect(skill.updatedAt).toBeInstanceOf(Date)
    })

    it('should accept explicit scope and parameters', () => {
      const skill = createSkillDescriptor({
        id: 'sk2',
        name: 'Global Skill',
        description: 'Global scope skill',
        scope: 'global',
        parameters: { type: 'object', properties: {} },
      })
      expect(skill.scope).toBe('global')
      expect(skill.parameters).toEqual({ type: 'object', properties: {} })
    })

    it('should throw on empty name', () => {
      expect(() =>
        createSkillDescriptor({
          id: 'sk3',
          name: '',
          description: 'bad',
        }),
      ).toThrow('Skill name must be non-empty')

      expect(() =>
        createSkillDescriptor({
          id: 'sk4',
          name: '   ',
          description: 'bad',
        }),
      ).toThrow('Skill name must be non-empty')
    })
  })

  describe('promoteSkill', () => {
    it('should set promotedFrom and increment version', () => {
      const skill = createSkillDescriptor({
        id: 'sk1',
        name: 'Evolvable Skill',
        description: 'From trace',
      })
      expect(skill.version).toBe(1)
      expect(skill.promotedFrom).toBeUndefined()

      promoteSkill(skill, 'review-xyz')
      expect(skill.promotedFrom).toBe('review-xyz')
      expect(skill.version).toBe(2)
      expect(skill.updatedAt).toBeInstanceOf(Date)
    })

    it('should increment version further on multiple promotions', () => {
      const skill = createSkillDescriptor({
        id: 'sk1',
        name: 'Multi-promote',
        description: 'Test',
      })
      promoteSkill(skill, 'review-1')
      expect(skill.version).toBe(2)

      promoteSkill(skill, 'review-2')
      expect(skill.version).toBe(3)

      promoteSkill(skill, 'review-3')
      expect(skill.version).toBe(4)
    })
  })
})
