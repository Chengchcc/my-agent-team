import { describe, it, expect } from 'bun:test';
import { parseSlashCommandInvocation, DAEMON_COMMANDS } from '../../src/daemon/command-handler';

describe('parseSlashCommandInvocation', () => {
  it('parses command without arguments', () => {
    const result = parseSlashCommandInvocation('/status');
    expect(result).toEqual({ cmd: '/status', content: '' });
  });

  it('parses command with arguments', () => {
    const result = parseSlashCommandInvocation('/t write a hello world');
    expect(result).toEqual({ cmd: '/t', content: 'write a hello world' });
  });

  it('returns null for non-slash content', () => {
    expect(parseSlashCommandInvocation('hello')).toBeNull();
    expect(parseSlashCommandInvocation('')).toBeNull();
  });
});

describe('DAEMON_COMMANDS', () => {
  it('includes all expected commands', () => {
    expect(DAEMON_COMMANDS.has('/repo')).toBe(true);
    expect(DAEMON_COMMANDS.has('/restart')).toBe(true);
    expect(DAEMON_COMMANDS.has('/close')).toBe(true);
    expect(DAEMON_COMMANDS.has('/status')).toBe(true);
    expect(DAEMON_COMMANDS.has('/skip')).toBe(true);
    expect(DAEMON_COMMANDS.has('/help')).toBe(true);
  });

  it('does not include non-commands', () => {
    expect(DAEMON_COMMANDS.has('/random')).toBe(false);
    expect(DAEMON_COMMANDS.has('/compact')).toBe(false);
  });
});
