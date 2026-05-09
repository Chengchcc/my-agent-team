import { describe, test, expect } from 'bun:test';
import { IdleGate } from '../../src/evolution/idle-gate';

describe('IdleGate', () => {
  test('allows execution when idle', () => {
    const gate = new IdleGate();
    expect(gate.canRun()).toBe(true);
  });

  test('blocks when streaming', () => {
    const gate = new IdleGate();
    gate.setStreaming(true);
    expect(gate.canRun()).toBe(false);
  });

  test('blocks when compacting', () => {
    const gate = new IdleGate();
    gate.setCompacting(true);
    expect(gate.canRun()).toBe(false);
  });

  test('allows after streaming stops', () => {
    const gate = new IdleGate();
    gate.setStreaming(true);
    gate.setStreaming(false);
    expect(gate.canRun()).toBe(true);
  });
});
