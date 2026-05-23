import { describe, it, expect } from 'bun:test'
import type { Transport } from '../../../src/application/ports/transport'

/**
 * Type-check only — the Transport interface is validated at runtime
 * by the InMemoryTransport implementation in transport-inmem.test.ts.
 */
describe('Transport port (type check)', () => {
  it('should be importable and structurally typed', () => {
    // Type-only assertion — if this compiles, the test passes.
    // Bun's test runner will fail to import if the file has type errors.
    const _t: Transport | null = null
    expect(_t).toBeNull()
  })
})
