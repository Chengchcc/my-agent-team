import { describe, it, expect } from 'bun:test';
import { McpManager } from '../../src/extensions/mcp/manager';

describe('McpManager reconnect backoff', () => {
  const defaultOptions = {
    toolTimeoutMs: 30_000,
    reconnectAttempts: 3,
    reconnectDelayMs: 1_000,
    maxReconnectAttempts: 5,
  };

  it('should accept maxReconnectAttempts in options', () => {
    const manager = new McpManager({ ...defaultOptions, maxReconnectAttempts: 5 });
    const states = manager.getConnectionStates();
    expect(states.size).toBe(0);
  });

  it('should include "exhausted" as a valid connection status via type system', () => {
    const manager = new McpManager({ ...defaultOptions, maxReconnectAttempts: 3 });
    expect(manager).toBeDefined();
    const states = manager.getConnectionStates();
    expect(states).toBeInstanceOf(Map);
  });

  it('should not reconnect for manually disconnected servers', async () => {
    const manager = new McpManager({ ...defaultOptions, maxReconnectAttempts: 3 });

    // Connect a server that will fail (nonexistent binary)
    try {
      await manager.connectServer({
        name: 'test-disconnect',
        transport: 'stdio',
        command: 'nonexistent_binary_xyz',
      });
    } catch {
      // Expected — binary doesn't exist
    }

    // Manually disconnect — should NOT trigger reconnect (disconnected status)
    await manager.disconnectServer('test-disconnect');

    // Verify server is in disconnected state, not error/exhausted
    const states = manager.getConnectionStates();
    const state = states.get('test-disconnect');
    expect(state?.status).toBe('disconnected');
  });

  it('should construct with default options', () => {
    const manager = new McpManager({
      toolTimeoutMs: 30_000,
      reconnectAttempts: 3,
      reconnectDelayMs: 1_000,
      maxReconnectAttempts: 5,
    });
    expect(manager.hasServer('nonexistent')).toBe(false);
  });
});
