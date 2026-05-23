import { describe, it, expect } from 'bun:test';
import { McpManager } from '../../src/extensions/mcp/manager';

describe('McpManager', () => {
  const defaultOptions = {
    toolTimeoutMs: 30_000,
    reconnectAttempts: 3,
    reconnectDelayMs: 1_000,
  };

  describe('lifecycle', () => {
    it('should start with empty server map', () => {
      const manager = new McpManager(defaultOptions);
      const states = manager.getConnectionStates();
      expect(states.size).toBe(0);
    });

    it('should return false for hasServer on unknown server', () => {
      const manager = new McpManager(defaultOptions);
      expect(manager.hasServer('nonexistent')).toBe(false);
    });

    it('should disconnect an unknown server without error', async () => {
      const manager = new McpManager(defaultOptions);
      await manager.disconnectServer('unknown');
    });

    it('should remove an unknown server without error', async () => {
      const manager = new McpManager(defaultOptions);
      await manager.removeServer('unknown');
    });

    it('should be a no-op calling start with empty server list', async () => {
      const manager = new McpManager(defaultOptions);
      await manager.start([]);
      expect(manager.getConnectionStates().size).toBe(0);
    });

    it('should skip servers with autoStart: false in start()', async () => {
      const manager = new McpManager(defaultOptions);
      await manager.start([
        {
          name: 'disabled-server',
          transport: 'stdio',
          command: 'nonexistent_binary_xyz',
          autoStart: false,
        },
      ]);
      expect(manager.getConnectionStates().size).toBe(0);
    });

    it('should shutdown without error when no servers are connected', async () => {
      const manager = new McpManager(defaultOptions);
      await manager.shutdown();
    });
  });

  describe('connectServer validation', () => {
    it('should throw when connecting a server with duplicate name', async () => {
      const manager = new McpManager(defaultOptions);
      // First call fails because the binary doesn't exist, but it stores an error-state entry
      try {
        await manager.connectServer({
          name: 'dup-test',
          transport: 'stdio',
          command: 'nonexistent_binary_xyz',
        });
      } catch {
        // expected — binary not found
      }
      // The entry now exists in error state, so a second connectServer must throw
      await expect(
        manager.connectServer({
          name: 'dup-test',
          transport: 'stdio',
          command: 'nonexistent_binary_xyz',
        }),
      ).rejects.toThrow("already connected");
    });
  });

  describe('execute errors', () => {
    it('should throw when executeTool called with unknown server', async () => {
      const manager = new McpManager(defaultOptions);
      await expect(manager.executeTool('unknown', 'tool', {})).rejects.toThrow("is not connected");
    });

    it('should throw when readResource called with unknown server', async () => {
      const manager = new McpManager(defaultOptions);
      await expect(manager.readResource('unknown', 'res://x')).rejects.toThrow("is not connected");
    });

    it('should throw when getPrompt called with unknown server', async () => {
      const manager = new McpManager(defaultOptions);
      await expect(manager.getPrompt('unknown', 'prompt', {})).rejects.toThrow("is not connected");
    });
  });

  describe('getAll* empty state', () => {
    it('should return empty arrays when no servers are connected', () => {
      const manager = new McpManager(defaultOptions);
      expect(manager.getAllTools()).toEqual([]);
      expect(manager.getAllResources()).toEqual([]);
      expect(manager.getAllPrompts()).toEqual([]);
    });

    it('should return empty arrays for getServerTools/getServerPrompts when server not found', () => {
      const manager = new McpManager(defaultOptions);
      expect(manager.getServerTools('nonexistent')).toEqual([]);
      expect(manager.getServerPrompts('nonexistent')).toEqual([]);
    });
  });

  describe('getConnectionStates ReturnType', () => {
    it('should return a ReadonlyMap', () => {
      const manager = new McpManager(defaultOptions);
      const states = manager.getConnectionStates();
      expect(states).toBeInstanceOf(Map);
    });
  });
});
