import { describe, it, expect } from 'bun:test';
import { generateULID, isValidULID, ulidTimestamp } from '../../src/shared/ulid';

describe('ULID', () => {
  it('should generate valid ULID', () => {
    const id = generateULID();
    expect(id).toBeString();
    expect(id.length).toBe(26);
    expect(isValidULID(id)).toBe(true);
  });

  it('should validate ULID format', () => {
    expect(isValidULID('01ARZ3NDEK4444444444444444')).toBe(true);
    expect(isValidULID('invalid')).toBe(false);
    expect(isValidULID('')).toBe(false);
    expect(isValidULID('01ARZ3NDEK444444444444444444')).toBe(false); // 27 chars
  });

  it('should extract timestamp', () => {
    const id = generateULID();
    const ts = ulidTimestamp(id);
    expect(ts).toBeNumber();
    expect(ts).toBeGreaterThan(Date.now() - 1000);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it('should generate monotonic ULIDs', () => {
    const ids = Array.from({ length: 100 }, () => generateULID());
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] >= ids[i-1]).toBe(true);
    }
  });
});
