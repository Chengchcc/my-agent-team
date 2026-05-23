import { describe, it, expect } from 'bun:test'
import {
  createMemoryEntry,
  markHit,
  decayWeight,
} from '../../src/domain/memory-entry'
import type { MemoryEntry } from '../../src/domain/memory-entry'

describe('MemoryEntry', () => {
  describe('createMemoryEntry', () => {
    it('should create with defaults: weight=1.0, source=explicit, usageCount=0, empty tags', () => {
      const entry = createMemoryEntry({
        id: 'm1',
        type: 'general',
        text: 'test memory',
      })
      expect(entry.id).toBe('m1')
      expect(entry.type).toBe('general')
      expect(entry.text).toBe('test memory')
      expect(entry.weight).toBe(1.0)
      expect(entry.source).toBe('explicit')
      expect(entry.tags).toEqual([])
      expect(entry.usageCount).toBe(0)
      expect(entry.createdAt).toBeInstanceOf(Date)
      expect(entry.updatedAt).toBeInstanceOf(Date)
      expect(entry.lastHitAt).toBeUndefined()
      expect(entry.embedding).toBeUndefined()
    })

    it('should accept explicit source and custom weight', () => {
      const entry = createMemoryEntry({
        id: 'm2',
        type: 'user_preference',
        text: 'prefers dark mode',
        weight: 0.8,
        source: 'user',
      })
      expect(entry.weight).toBe(0.8)
      expect(entry.source).toBe('user')
      expect(entry.type).toBe('user_preference')
    })

    it('should accept tags array', () => {
      const entry = createMemoryEntry({
        id: 'm3',
        type: 'project_rule',
        text: 'use tabs',
        tags: ['coding-style', 'indent'],
      })
      expect(entry.tags).toEqual(['coding-style', 'indent'])
    })

    it('should clamp weight to 0-1 on create', () => {
      const entryHigh = createMemoryEntry({
        id: 'm4',
        type: 'agent_md',
        text: 'high weight',
        weight: 2.5,
      })
      expect(entryHigh.weight).toBe(1.0)

      const entryLow = createMemoryEntry({
        id: 'm5',
        type: 'general',
        text: 'low weight',
        weight: -0.5,
      })
      expect(entryLow.weight).toBe(0)
    })
  })

  describe('markHit', () => {
    it('should increment usageCount and set lastHitAt', () => {
      const entry = createMemoryEntry({
        id: 'm1',
        type: 'general',
        text: 'test',
      })
      expect(entry.usageCount).toBe(0)
      expect(entry.lastHitAt).toBeUndefined()

      markHit(entry)
      expect(entry.usageCount).toBe(1)
      expect(entry.lastHitAt).toBeInstanceOf(Date)

      markHit(entry)
      expect(entry.usageCount).toBe(2)
    })
  })

  describe('decayWeight', () => {
    it('should reduce weight by given factor', () => {
      const entry = createMemoryEntry({
        id: 'm1',
        type: 'general',
        text: 'test',
        weight: 1.0,
      })
      decayWeight(entry, 0.5)
      expect(entry.weight).toBe(0.5)

      decayWeight(entry, 0.5)
      expect(entry.weight).toBe(0.25)
    })

    it('should default to factor 0.95', () => {
      const entry = createMemoryEntry({
        id: 'm1',
        type: 'general',
        text: 'test',
        weight: 1.0,
      })
      decayWeight(entry)
      expect(entry.weight).toBe(0.95)
    })

    it('should clamp weight at 0 after decay with negative factor', () => {
      const entry = createMemoryEntry({
        id: 'm1',
        type: 'general',
        text: 'test',
        weight: 0.5,
      })
      decayWeight(entry, -0.5)
      expect(entry.weight).toBe(0)
    })
  })
})
