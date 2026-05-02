import { appendFileSync } from 'node:fs';

let debugMode = false;
let debugFile: string | null = null;

export function isDebugEnabled(): boolean {
  return debugMode;
}

export function setDebugMode(enabled: boolean, file?: string): void {
  debugMode = enabled;
  debugFile = file ?? null;
}

function writeLine(line: string): void {
  if (debugFile) {
    try { appendFileSync(debugFile, line); } catch { /* ignore write errors */ }
  } else {
    console.warn(line);
  }
}

export function debugLog(...args: unknown[]): void {
  if (!debugMode) return;
  const line = `[${new Date().toISOString()}] ${args.map(a =>
    typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  writeLine(line);
}

export function debugWarn(...args: unknown[]): void {
  if (!debugMode) return;
  const line = `[${new Date().toISOString()}] WARN ${args.map(a =>
    typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  writeLine(line);
}

export function debugError(...args: unknown[]): void {
  if (!debugMode) return;
  const line = `[${new Date().toISOString()}] ERROR ${args.map(a =>
    typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  writeLine(line);
}
