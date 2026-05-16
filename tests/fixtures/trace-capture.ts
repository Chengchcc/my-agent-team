import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface TraceEntry {
  type: 'turn' | 'tool';
  turnIndex?: number;
  userMessage?: string;
  modelResponse?: unknown;
  toolName?: string;
  success?: boolean;
  durationMs?: number;
  error?: string;
}

export class TraceCapture {
  constructor(private baseDir: string) {}

  waitForFile(sessionId: string, timeoutMs: number = 5000): string | null {
    const start = Date.now();
    const dir = join(this.baseDir, sessionId);
    while (Date.now() - start < timeoutMs) {
      try {
        const files = readdirSync(dir);
        if (files.length > 0) {
          return join(dir, files[0]!);
        }
      } catch { /* dir not yet created */ }
    }
    return null;
  }

  parseJsonl(filePath: string): TraceEntry[] {
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, 'utf-8');
    return content.split('\n').filter(Boolean).map(line => JSON.parse(line) as TraceEntry);
  }

  getLastEntry(sessionId: string): TraceEntry | null {
    const dir = join(this.baseDir, sessionId);
    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
      if (files.length === 0) return null;
      const entries = this.parseJsonl(join(dir, files[files.length - 1]!));
      return entries.length > 0 ? entries[entries.length - 1]! : null;
    } catch {
      return null;
    }
  }
}
