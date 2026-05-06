import type { TraceRedactor } from './types';

const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9_-]{20,}\b/g,
  /\bghp_[a-zA-Z0-9]{20,}\b/g,
  /\bgho_[a-zA-Z0-9]{20,}\b/g,
  /\bghu_[a-zA-Z0-9]{20,}\b/g,
  /\bghs_[a-zA-Z0-9]{20,}\b/g,
  /\bxox[bpts]-[a-zA-Z0-9-]{20,}\b/g,
  /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----[^]*?-----END(?: [A-Z]+)* PRIVATE KEY-----/g,
];

const MAX_PATH_LENGTH = 120;

function looksLikePath(s: string): boolean {
  return s.includes('/') && s.length > MAX_PATH_LENGTH;
}

function truncatePath(s: string): string {
  if (!looksLikePath(s)) return s;
  const lastSlash = s.lastIndexOf('/');
  return `...${s.slice(lastSlash)}`;
}

export class DefaultRedactor implements TraceRedactor {
  private mode: 'default' | 'none';

  constructor(mode: 'default' | 'none' = 'default') {
    this.mode = mode;
  }

  redactText(text: string): string {
    if (this.mode === 'none') return text;
    let result = text;
    for (const pattern of SECRET_PATTERNS) {
      result = result.replace(pattern, '[REDACTED]');
    }
    return result;
  }

  redactToolArguments(_toolName: string, args: Record<string, unknown>): Record<string, unknown> {
    if (this.mode === 'none') return args;
    return this.redactObject(args);
  }

  private redactObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        if (this.isSecret(value)) {
          result[key] = '[REDACTED]';
        } else {
          result[key] = truncatePath(value);
        }
      } else if (Array.isArray(value)) {
        result[key] = (value as unknown[]).map(item => {
          if (typeof item !== 'string') return item;
          if (this.isSecret(item)) return '[REDACTED]';
          return truncatePath(item);
        });
      } else if (typeof value === 'object' && value !== null) {
        result[key] = this.redactObject(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private isSecret(value: string): boolean {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(value)) return true;
    }
    return false;
  }
}
