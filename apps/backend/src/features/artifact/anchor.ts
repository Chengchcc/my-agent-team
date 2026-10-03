/** ADR-era comment anchors (raft absorption): a comment targets a spot in
 *  an artifact. The structured anchor rides on the ledger message for the
 *  UI's jump chip; describeAnchor renders the human/agent-readable form that
 *  is baked into the message text. */

export type ArtifactAnchor =
  | { kind: "lines"; start: number; end?: number }
  | { kind: "rows"; start: number; end?: number }
  | { kind: "region"; label: string }
  | { kind: "moment"; at: number };

export function isArtifactAnchor(v: unknown): v is ArtifactAnchor {
  if (typeof v !== "object" || v === null) return false;
  const a = v as { kind?: unknown; start?: unknown; end?: unknown; label?: unknown; at?: unknown };
  switch (a.kind) {
    case "lines":
    case "rows":
      return typeof a.start === "number" && (a.end === undefined || typeof a.end === "number");
    case "region":
      return typeof a.label === "string" && a.label.length > 0;
    case "moment":
      return typeof a.at === "number";
    default:
      return false;
  }
}

/** Human+agent readable anchor text: "x.ts L42-45". */
export function describeAnchor(filename: string, anchor: ArtifactAnchor): string {
  const range = (start: number, end?: number) =>
    end !== undefined && end !== start ? `${start}-${end}` : `${start}`;
  switch (anchor.kind) {
    case "lines":
      return `${filename} L${range(anchor.start, anchor.end)}`;
    case "rows":
      return `${filename} rows ${range(anchor.start, anchor.end)}`;
    case "region":
      return `${filename} (${anchor.label})`;
    case "moment": {
      const m = Math.floor(anchor.at / 60);
      const s = anchor.at % 60;
      return `${filename} @${m}:${s.toString().padStart(2, "0")}`;
    }
  }
}
