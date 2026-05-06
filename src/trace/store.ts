import fs from 'fs/promises';
import path from 'path';
import type { TraceRun, TraceEntry, TraceTurn, TraceSummary } from './types';

const DEFAULT_MAX_RUNS = 50;
const DEFAULT_SESSION_LIMIT = 10;
const DEFAULT_RUN_LIMIT = 5;

export class TraceStore {
  private baseDir: string;
  private maxRunsPerSession: number;

  constructor(baseDir: string, maxRunsPerSession: number = DEFAULT_MAX_RUNS) {
    this.baseDir = baseDir;
    this.maxRunsPerSession = maxRunsPerSession;
  }

  private runPath(runId: string, sessionId: string): string {
    return path.join(this.baseDir, sessionId, `${runId}.jsonl`);
  }

  async appendTurn(runId: string, sessionId: string, entry: TraceEntry): Promise<void> {
    const filePath = this.runPath(runId, sessionId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  async finalize(trace: TraceRun): Promise<void> {
    const summaryEntry: TraceEntry = { type: 'summary', ...trace.summary };
    await this.appendTurn(trace.id, trace.sessionId, summaryEntry);

    // Enforce retention — delete oldest runs by mtime
    const sessionDir = path.join(this.baseDir, trace.sessionId);
    const files = await fs.readdir(sessionDir);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
    if (jsonlFiles.length > this.maxRunsPerSession) {
      const withMtime = await Promise.all(
        jsonlFiles.map(async (f) => {
          try {
            const stat = await fs.stat(path.join(sessionDir, f));
            return { name: f, mtime: stat.mtimeMs };
          } catch {
            return { name: f, mtime: 0 };
          }
        }),
      );
      const sorted = withMtime.sort((a, b) => a.mtime - b.mtime);
      const toDelete = sorted.slice(0, jsonlFiles.length - this.maxRunsPerSession);
      for (const f of toDelete) {
        await fs.unlink(path.join(sessionDir, f.name)).catch(() => {});
      }
    }
  }

  async get(runId: string, sessionId: string): Promise<TraceRun | null> {
    const filePath = this.runPath(runId, sessionId);
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }

    const lines = content.trim().split('\n').filter(Boolean);
    const turns: TraceTurn[] = [];
    let summary: TraceSummary | undefined;

    for (const line of lines) {
      const entry = JSON.parse(line) as TraceEntry;
      if (entry.type === 'turn') {
        const { type: _, turnIndex, ...rest } = entry as TraceEntry & { type: 'turn' };
        void _;
        turns.push({ turnIndex, ...rest } as TraceTurn);
      } else if (entry.type === 'tool') {
        const lastTurn = turns[turns.length - 1];
        if (lastTurn) {
          const { type: _, ...exec } = entry as TraceEntry & { type: 'tool' };
          void _;
          lastTurn.toolExecutions.push(exec);
        }
      } else if (entry.type === 'summary') {
        const { type: _, ...sum } = entry as TraceEntry & { type: 'summary' };
        void _;
        summary = sum;
      }
    }

    if (!summary) return null;

    return {
      id: runId,
      sessionId,
      startTime: 0,
      endTime: 0,
      model: '',
      turns,
      summary,
    };
  }

  async listBySession(sessionId: string, limit?: number): Promise<string[]> {
    const sessionDir = path.join(this.baseDir, sessionId);
    let files: string[];
    try {
      files = await fs.readdir(sessionDir);
    } catch {
      return [];
    }
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
    const withMtime = await Promise.all(
      jsonlFiles.map(async (f) => {
        try {
          const stat = await fs.stat(path.join(sessionDir, f));
          return { name: f, mtime: stat.mtimeMs };
        } catch {
          return { name: f, mtime: 0 };
        }
      }),
    );
    return withMtime
      .sort((a, b) => b.mtime - a.mtime)
      .map(f => f.name.replace('.jsonl', ''))
      .slice(0, limit ?? this.maxRunsPerSession);
  }

  async listRecent(sessionLimit = DEFAULT_SESSION_LIMIT, runLimit?: number): Promise<TraceRun[]> {
    let sessionDirs: string[];
    try {
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
      const dirNames = entries.filter(e => e.isDirectory()).map(e => e.name);
      const withMtime = await Promise.all(
        dirNames.map(async (d) => {
          try {
            const stat = await fs.stat(path.join(this.baseDir, d));
            return { name: d, mtime: stat.mtimeMs };
          } catch {
            return { name: d, mtime: 0 };
          }
        }),
      );
      sessionDirs = withMtime.sort((a, b) => b.mtime - a.mtime).map(d => d.name);
    } catch {
      return [];
    }

    const runs: TraceRun[] = [];
    for (const sessionId of sessionDirs.slice(0, sessionLimit)) {
      const runIds = await this.listBySession(sessionId, runLimit ?? DEFAULT_RUN_LIMIT);
      for (const runId of runIds) {
        const run = await this.get(runId, sessionId);
        if (run) runs.push(run);
      }
    }
    return runs;
  }
}
