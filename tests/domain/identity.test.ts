import { describe, it, expect } from 'bun:test'
import {
  createIdentity,
  applyDiff,
  rollback,
} from '../../src/domain/identity'
import type { Identity } from '../../src/domain/identity'

describe('Identity', () => {
  describe('createIdentity', () => {
    it('should create with defaults: version=1, empty content, no previousVersion', () => {
      const identity = createIdentity('agent-1')
      expect(identity.agentId).toBe('agent-1')
      expect(identity.version).toBe(1)
      expect(identity.content).toEqual({})
      expect(identity.updatedAt).toBeInstanceOf(Date)
      expect(identity.previousVersion).toBeUndefined()
    })

    it('should accept initial content', () => {
      const identity = createIdentity('agent-1', { name: 'Alice', age: 30 })
      expect(identity.content).toEqual({ name: 'Alice', age: 30 })
    })
  })

  describe('applyDiff', () => {
    it('should create diff, increment version, and apply changes', () => {
      const identity = createIdentity('agent-1', { name: 'Alice', age: 30 })
      const diff = applyDiff(identity, { name: 'Bob', city: 'NYC' })

      expect(diff.agentId).toBe('agent-1')
      expect(diff.fromVersion).toBe(1)
      expect(diff.toVersion).toBe(2)
      expect(diff.changes).toEqual({
        name: { from: 'Alice', to: 'Bob' },
        city: { from: undefined, to: 'NYC' },
      })
      expect(diff.createdAt).toBeInstanceOf(Date)

      expect(identity.version).toBe(2)
      expect(identity.previousVersion).toBe(1)
      expect(identity.content).toEqual({ name: 'Bob', age: 30, city: 'NYC' })
    })

    it('should produce version monotonic increases', () => {
      const identity = createIdentity('agent-1')
      expect(identity.version).toBe(1)

      applyDiff(identity, { a: 1 })
      expect(identity.version).toBe(2)

      applyDiff(identity, { b: 2 })
      expect(identity.version).toBe(3)

      applyDiff(identity, { c: 3 })
      expect(identity.version).toBe(4)
    })
  })

  describe('rollback', () => {
    it('should rollback to a previous version', () => {
      const identity = createIdentity('agent-1', { v: 1 })
      applyDiff(identity, { v: 2 })
      applyDiff(identity, { v: 3 })
      expect(identity.version).toBe(3)

      rollback(identity, 2)
      expect(identity.version).toBe(2)
      expect(identity.previousVersion).toBe(3)
    })

    it('should throw if target version is not less than current', () => {
      const identity = createIdentity('agent-1')
      applyDiff(identity, { a: 1 })
      expect(identity.version).toBe(2)

      expect(() => rollback(identity, 2)).toThrow(
        'Rollback target version (2) must be less than current version (2)',
      )
      expect(() => rollback(identity, 3)).toThrow(
        'Rollback target version (3) must be less than current version (2)',
      )
    })
  })

  describe('invariants', () => {
    it('should always have content as an object', () => {
      const identity = createIdentity('agent-1')
      expect(typeof identity.content).toBe('object')
      expect(identity.content).not.toBeNull()

      applyDiff(identity, { key: 'value' })
      expect(typeof identity.content).toBe('object')
    })
  })
})
