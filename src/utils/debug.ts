import { appendFileSync } from 'node:fs';

let debugMode = false;
let debugFile: string | null = null;
let debugLineCount = 0;
const MAX_DEBUG_LINES = 1000;

export function isDebugEnabled(): boolean {
  return debugMode;
}

export function setDebugMode(enabled: boolean, file?: string): void {
  debugMode = enabled;
  debugFile = file ?? null;
}

function writeLine(line: string): void {
  debugLineCount++;
  if (debugLineCount > MAX_DEBUG_LINES) return;
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
