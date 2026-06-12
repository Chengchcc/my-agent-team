/**
 * NDJSON framer: one JSON object per line, UTF-8, `\n` delimited.
 * Handles partial chunks (half-frame) and multiple frames per chunk (stick).
 */
export function createFramer(
  onMessage: (obj: unknown) => void,
  onBadFrame: (line: string) => void,
  maxBadFrames = 16,
) {
  let buf = "";
  let badCount = 0;

  return {
    feed(chunk: string | Uint8Array): void {
      buf = buf.concat(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) {
          try {
            onMessage(JSON.parse(line));
            badCount = 0; // reset on success
          } catch {
            badCount++;
            onBadFrame(line);
            if (badCount >= maxBadFrames) {
              throw new Error(`NDJSON framer: ${badCount} consecutive bad frames, closing`);
            }
          }
        }
        nl = buf.indexOf("\n");
      }
    },

    reset(): void {
      buf = "";
      badCount = 0;
    },
  };
}

/** Encode a message as an NDJSON line. */
export function encode(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
