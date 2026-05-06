import { describe, test, expect } from 'bun:test';
import { DefaultRedactor } from '../../src/trace/redactor';

describe('DefaultRedactor', () => {
  const redactor = new DefaultRedactor();

  test('redacts API key patterns in text', () => {
    const result = redactor.redactText(
      'my key is sk-abc123xyz4567890123456 and ghp_token45678901234567890',
    );
    expect(result).not.toContain('sk-abc123xyz4567890123456');
    expect(result).not.toContain('ghp_token45678901234567890');
    expect(result).toContain('[REDACTED]');
  });

  test('redacts BEGIN/END private key blocks', () => {
    const input =
      'key: -----BEGIN PRIVATE KEY-----\nMIICdgIBADANBgkqhkiG9w0BAQEFAASCAmAwggJcAgEAAoGB\n-----END PRIVATE KEY-----';
    const result = redactor.redactText(input);
    expect(result).not.toContain('BEGIN PRIVATE KEY');
    expect(result).toContain('[REDACTED]');
  });

  test('does not redact normal text', () => {
    const input = 'The file is at /home/user/project/src/index.ts';
    const result = redactor.redactText(input);
    expect(result).toBe(input);
  });

  test('redacts API key in tool arguments', () => {
    const args = {
      apiKey: 'sk-abc123xyz4567890123456',
      name: 'test',
      nested: { token: 'ghp_token45678901234567890' },
    };
    const result = redactor.redactToolArguments('some_tool', args);
    expect(result.apiKey).toBe('[REDACTED]');
    expect(result.name).toBe('test');
    expect((result.nested as Record<string, unknown>).token).toBe('[REDACTED]');
  });

  test('redacts secret patterns in array arguments', () => {
    const args = {
      env: ['NODE_ENV=production', 'GITHUB_TOKEN=ghp_token45678901234567890'],
      flags: ['--verbose'],
    };
    const result = redactor.redactToolArguments('bash', args);
    const envArr = result.env as unknown[];
    expect(envArr[0]).toBe('NODE_ENV=production');
    expect(envArr[1]).toBe('[REDACTED]');
    expect(result.flags).toEqual(['--verbose']);
  });

  test('mode=none redacts nothing', () => {
    const noop = new DefaultRedactor('none');
    const result = noop.redactText('key is sk-abc123xyz4567890123456');
    expect(result).toBe('key is sk-abc123xyz4567890123456');
  });
});
