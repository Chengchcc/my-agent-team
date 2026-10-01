/** Env-gated debug line (OMA_DEBUG=1): one line to stderr, nothing when off.
 *  Lives in the protocol module rather than infra because it is part of the
 *  run dispatch vocabulary, not a generic backend utility. */

/** Emit a tagged debug line when OMA_DEBUG is set. */
export function debugLog(tag: string, message: string): void {
  if (process.env.OMA_DEBUG !== "1" && process.env.OMA_DEBUG !== "true") return;
  process.stderr.write(`[${tag}] ${message}\n`);
}
