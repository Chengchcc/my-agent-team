/** Env-gated debug line (OMA_DEBUG=1): one line to stderr, nothing when off. */
export function debugLog(tag: string, message: string): void {
  if (process.env.OMA_DEBUG !== "1" && process.env.OMA_DEBUG !== "true") return;
  process.stderr.write(`[${tag}] ${message}\n`);
}
