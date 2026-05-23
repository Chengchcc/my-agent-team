import { exec } from 'child_process';
import path from 'path';
import type { ToolContext } from '../../application/ports/tool-context';
import type { BashArgs } from '../../application/contracts/tool-schemas/bash';

import { MB } from '../../application/constants/units';

const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = MB;
const CHILD_PROCESS_MAX_BUFFER = 10 * MB;
const SIGTERM_EXIT_CODE = 130;
const TIMEOUT_EXIT_CODE = 124;

export type BashToolOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowedWorkingDirs?: string[];
};

export function createBashExecute(options: BashToolOptions = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const allowedWorkingDirs = options.allowedWorkingDirs ?? [];

  return function bashExecute(
    args: BashArgs,
    ctx: ToolContext,
  ): Promise<{ output: string; exitCode: number | null; timedOut: boolean; truncated: boolean }> {
    const cwd = path.resolve(args.cwd ?? ctx.environment.cwd);
    if (allowedWorkingDirs.length > 0) {
      const isAllowed = allowedWorkingDirs.some((allowed) => {
        const resolvedAllowed = path.resolve(allowed);
        return cwd === resolvedAllowed || cwd.startsWith(resolvedAllowed + path.sep);
      });
      if (!isAllowed) {
        return Promise.resolve({ output: `Error: Working directory "${cwd}" is not allowed.`, exitCode: 1, timedOut: false, truncated: false });
      }
    }

    return new Promise((resolve) => {
      let output = '';
      let outputBytes = 0;
      let truncated = false;
      const proc = exec(args.command, { cwd, maxBuffer: CHILD_PROCESS_MAX_BUFFER, timeout: timeoutMs });
      let resolved = false;

      const handleData = (data: Buffer | string) => {
        const bytes = Buffer.byteLength(data);
        if (outputBytes + bytes > maxOutputBytes) {
          truncated = true;
          const remaining = maxOutputBytes - outputBytes;
          output += data.toString().slice(0, remaining);
          outputBytes = maxOutputBytes;
        } else {
          output += data.toString();
          outputBytes += bytes;
        }
      };

      proc.stdout?.on('data', handleData);
      proc.stderr?.on('data', handleData);

      proc.on('error', (error) => {
        output += `Error: ${error.message}`;
        resolve({ output, exitCode: 1, timedOut: false, truncated });
      });

      if (ctx.signal) {
        const handleAbort = () => {
          if (resolved) return;
          cleanup();
          if (proc?.pid) {
            try { process.kill(-proc.pid); } catch { try { proc.kill(); } catch { /* already exited */ } }
          }
          output += '\n--- Command aborted by user ---';
          resolved = true;
          resolve({ output, exitCode: SIGTERM_EXIT_CODE, timedOut: false, truncated });
        };
        const cleanup = () => ctx.signal.removeEventListener('abort', handleAbort);
        ctx.signal.addEventListener('abort', handleAbort);
        proc.on('exit', cleanup);
        proc.on('timeout', cleanup);
        proc.on('error', cleanup);
        if (ctx.signal.aborted) handleAbort();
      }

      proc.on('timeout', () => {
        proc.kill();
        output += `\n--- Command timed out after ${timeoutMs}ms ---`;
        resolved = true;
        resolve({ output, exitCode: TIMEOUT_EXIT_CODE, timedOut: true, truncated });
      });

      proc.on('exit', (code, signal) => {
        if (resolved) return;
        if (signal) output += `\n--- Killed by signal ${signal} ---`;
        const timedOut = timeoutMs > 0 && signal === 'SIGTERM';
        resolve({ output, exitCode: timedOut ? TIMEOUT_EXIT_CODE : code, timedOut, truncated });
      });
    });
  };
}
