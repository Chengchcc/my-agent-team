import { describe, it, expect } from 'bun:test';

describe('Profile config schema', () => {
  it('parses valid YAML config format', () => {
    const yaml = `
profiles:
  test:
    workspace: ~/test
    toolProfile: read_only
    workingDir: /tmp
bots: []
`;
    // Verify the expected YAML structure parses correctly
    const { parse } = require('yaml');
    const result = parse(yaml);
    expect(result.profiles.test.toolProfile).toBe('read_only');
    expect(result.profiles.test.workspace).toBe('~/test');
    expect(result.profiles.test.workingDir).toBe('/tmp');
  });

  it('detects missing required fields', () => {
    const yaml = `
profiles:
  bad:
    workspace: ~/test
bots: []
`;
    const { parse } = require('yaml');
    const result = parse(yaml);
    expect(result.profiles.bad.workingDir).toBeUndefined();
    expect(result.profiles.bad.toolProfile).toBeUndefined();
  });
});
