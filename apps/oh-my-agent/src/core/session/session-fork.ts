import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { newSessionId, sessionDir, sessionFilePath } from "./session-paths.js";

export interface SessionBranchNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: string;
  readonly text: string;
  readonly depth: number;
  /** 1-based user-message ordinal when this node is a user message (fork anchor). */
  readonly ordinal?: number;
}

interface SessionForkEvent {
  type?: string;
  message?: { role?: string; text?: string };
}

/** Read the durable event tree of one session as parentId-chained message
 *  nodes (used by the TUI branch-tree fork overlay). */
export function loadSessionBranchNodes(
  id: string,
  dir: string = sessionDir(),
): SessionBranchNode[] {
  const path = sessionFilePath(id, dir);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  const parents = new Map<string, string | null>();
  const nodes: Array<{
    id: string;
    parentId: string | null;
    role: string;
    text: string;
    ordinal?: number;
  }> = [];
  let userOrdinal = 0;
  for (const line of lines) {
    let evt: {
      type?: string;
      id?: string;
      parentId?: string | null;
      message?: { role?: string; text?: string };
    };
    try {
      evt = JSON.parse(line) as typeof evt;
    } catch {
      continue;
    }
    if (evt.type !== "message" || !evt.id || !evt.message?.role) continue;
    const role = evt.message.role;
    const parentId = evt.parentId ?? null;
    parents.set(evt.id, parentId);
    if (role === "user") userOrdinal += 1;
    const node: {
      id: string;
      parentId: string | null;
      role: string;
      text: string;
      ordinal?: number;
    } = {
      id: evt.id,
      parentId,
      role,
      text: typeof evt.message.text === "string" ? evt.message.text : "",
    };
    if (role === "user") node.ordinal = userOrdinal;
    nodes.push(node);
  }
  const depthOf = (nodeId: string): number => {
    let depth = 0;
    let cur: string | null | undefined = nodeId;
    const seen = new Set<string>();
    while (cur) {
      if (seen.has(cur)) break;
      seen.add(cur);
      const parent: string | null = parents.get(cur) ?? null;
      if (parent === null) break;
      depth += 1;
      cur = parent;
    }
    return depth;
  };
  return nodes.map((n) => ({ ...n, depth: depthOf(n.id) }));
}

function copySessionThrough(
  id: string,
  cutIndex: number,
  dir: string,
  markerFields: Record<string, unknown>,
): string | null {
  const path = sessionFilePath(id, dir);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  if (cutIndex < 0 || cutIndex >= lines.length) return null;
  const newId = newSessionId();
  const kept = lines.slice(0, cutIndex + 1);
  try {
    const header = JSON.parse(kept[0]!) as { type?: string; id?: string };
    if (header.type === "session") {
      header.id = newId;
      kept[0] = JSON.stringify(header);
    }
  } catch {
    /* keep the original header line */
  }
  const marker = JSON.stringify({ type: "fork_of", parentId: id, ...markerFields });
  writeFileSync(sessionFilePath(newId, dir), `${[...kept, marker].join("\n")}\n`);
  return newId;
}

/** Fork a session at the Nth user message (1-based) — the existing /fork semantics. */
export function forkSession(
  id: string,
  ordinal: number,
  dir: string = sessionDir(),
): string | null {
  const path = sessionFilePath(id, dir);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  let seen = 0;
  let cutIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    let evt: SessionForkEvent;
    try {
      evt = JSON.parse(lines[i]!) as SessionForkEvent;
    } catch {
      continue;
    }
    if (evt.type === "message" && evt.message?.role === "user") {
      seen += 1;
      if (seen === ordinal) {
        cutIndex = i;
        break;
      }
    }
  }
  if (cutIndex === -1) return null;
  return copySessionThrough(id, cutIndex, dir, { atMessage: ordinal });
}

/** Fork a session through a specific branch node (message event id). Includes
 *  an immediately paired `tool` response when cutting on `assistant(tool_use)`. */
export function forkSessionAtEvent(
  id: string,
  eventId: string,
  dir: string = sessionDir(),
): string | null {
  const path = sessionFilePath(id, dir);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  let cutIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    let evt: { id?: string };
    try {
      evt = JSON.parse(lines[i]!) as { id?: string };
    } catch {
      continue;
    }
    if (evt.id === eventId) {
      cutIndex = i;
      break;
    }
  }
  if (cutIndex === -1) return null;
  try {
    const cutEvt = JSON.parse(lines[cutIndex]!) as {
      type?: string;
      message?: { role?: string; blocks?: Array<{ type?: string }> };
    };
    const hasToolUse =
      cutEvt.type === "message" &&
      cutEvt.message?.role === "assistant" &&
      Array.isArray(cutEvt.message.blocks) &&
      cutEvt.message.blocks.some((b) => b.type === "tool_use");
    if (hasToolUse) {
      for (let j = cutIndex + 1; j < lines.length; j++) {
        let nextEvt: { type?: string; message?: { role?: string } };
        try {
          nextEvt = JSON.parse(lines[j]!) as typeof nextEvt;
        } catch {
          continue;
        }
        if (nextEvt.type !== "message") continue;
        if (nextEvt.message?.role === "tool") cutIndex = j;
        break;
      }
    }
  } catch {
    /* keep original cutIndex */
  }
  return copySessionThrough(id, cutIndex, dir, { atEvent: eventId });
}
