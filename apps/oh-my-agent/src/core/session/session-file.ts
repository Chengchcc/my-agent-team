import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  agentDir,
  assertSafeSessionId,
  newSessionId,
  sessionDir,
  sessionDirFor,
  sessionFilePath,
  sessionPath,
  sessionsRoot,
} from "./session-paths.js";

export {
  forkSession,
  forkSessionAtEvent,
  loadSessionBranchNodes,
  type SessionBranchNode,
} from "./session-fork.js";
export {
  appendParkedTurnMarker,
  appendSessionGoalCompletion,
  appendSessionGoalEvent,
  appendSessionPlanEvent,
  findInterruptedSession,
  loadLastParkedTurn,
  loadSessionGoalState,
  loadSessionPlanState,
} from "./session-markers.js";
export {
  agentDir,
  assertSafeSessionId,
  newSessionId,
  sessionDir,
  sessionDirFor,
  sessionPath,
  sessionsRoot,
};

/** Drop tool_result blocks whose tool_use is nowhere in the log. */
export function withoutOrphanToolResults(
  messages: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const answered = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const message of messages) {
    const role = message.role;
    const blocks = Array.isArray(message.blocks) ? (message.blocks as unknown[]) : [];
    if (role === "assistant") {
      for (const block of blocks) {
        if (
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "tool_use"
        ) {
          const id = (block as { id?: unknown }).id;
          if (typeof id === "string") answered.add(id);
        }
      }
      out.push(message);
      continue;
    }
    if (role !== "tool") {
      out.push(message);
      continue;
    }
    const kept = blocks.filter((block) => {
      if (typeof block !== "object" || block === null) return true;
      if ((block as { type?: unknown }).type !== "tool_result") return true;
      const id = (block as { tool_use_id?: unknown }).tool_use_id;
      return typeof id !== "string" || answered.has(id);
    });
    if (kept.length === blocks.length) out.push(message);
    else if (kept.length > 0) out.push({ ...message, blocks: kept });
  }
  return out;
}

/** Load the transcript messages of a session file (wire-loose shape). */
export function loadSessionMessages(
  id: string,
  dir: string = sessionDir(),
): Record<string, unknown>[] {
  const path = sessionFilePath(id, dir);
  if (!existsSync(path)) return [];
  const messages: Record<string, unknown>[] = [];
  let foldSummary: string | undefined;
  let foldFrom: number | undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line) as {
        type?: string;
        message?: Record<string, unknown>;
        summary?: string;
        replacesEarlierMessages?: unknown;
      };
      if (evt.type === "message" && evt.message?.role) messages.push(evt.message);
      else if (evt.type === "compaction" && typeof evt.summary === "string") {
        if (evt.replacesEarlierMessages !== false) {
          foldSummary = evt.summary;
          foldFrom = messages.length;
        }
      }
    } catch {
      /* skip malformed line */
    }
  }
  if (foldSummary === undefined || foldFrom === undefined) return messages;
  return [
    {
      role: "user",
      text: `<previous_session_summary>\n${foldSummary}\n</previous_session_summary>`,
      synthetic: "session-summary",
    },
    ...messages.slice(foldFrom),
  ];
}

export interface SessionSummary {
  readonly id: string;
  readonly modifiedAt: number;
  readonly title?: string;
  readonly summary?: string;
  readonly preview: string;
  readonly workspace?: string;
  /** Exact directory containing `<id>.jsonl` (used by resume/delete so
   *  OMA_SESSION_DIR, symlinks, and path-slug collisions always target the
   *  real file on disk). */
  readonly dir?: string;
  readonly forkOf?: string;
}

function canonicalWorkspacePath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function sameWorkspacePath(a: string, b: string): boolean {
  return canonicalWorkspacePath(a) === canonicalWorkspacePath(b);
}

function compareSessionsNewestFirst(a: SessionSummary, b: SessionSummary): number {
  return b.modifiedAt - a.modifiedAt || b.id.localeCompare(a.id);
}

interface SessionFileEvent {
  type?: string;
  title?: string;
  summary?: string;
  cwd?: string;
  message?: { role?: string; text?: string };
  parentId?: string;
}

/** Scan one session directory (all *.jsonl) into summaries. */
function scanSessionDir(dir: string, workspace?: string): SessionSummary[] {
  if (!existsSync(dir)) return [];
  const summaries: SessionSummary[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".jsonl")) continue;
    const id = entry.slice(0, -".jsonl".length);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
    const path = join(dir, entry);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    let preview = "";
    let title: string | undefined;
    let summaryText: string | undefined;
    let headerCwd: string | undefined;
    let forkOf: string | undefined;
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const evt = JSON.parse(line) as SessionFileEvent;
        if (evt.type === "session" && typeof evt.cwd === "string") {
          headerCwd = evt.cwd;
          continue;
        }
        if (evt.type === "title" && typeof evt.title === "string") {
          title = evt.title;
          continue;
        }
        if (evt.type === "summary" && typeof evt.summary === "string") {
          summaryText = evt.summary;
          continue;
        }
        if (evt.type === "fork_of" && typeof evt.parentId === "string") {
          forkOf = evt.parentId;
          continue;
        }
        if (!preview && evt.type === "message" && evt.message?.role === "user") {
          preview = String(evt.message.text ?? "")
            .replace(/\s+/g, " ")
            .slice(0, 60);
        }
      }
    } catch {
      /* corrupt file: listed with an empty preview */
    }
    const summary: {
      id: string;
      modifiedAt: number;
      preview: string;
      title?: string;
      summary?: string;
      workspace?: string;
      dir: string;
      forkOf?: string;
    } = { id, modifiedAt: mtimeMs, preview, dir };
    if (title !== undefined) summary.title = title;
    if (summaryText !== undefined) summary.summary = summaryText;
    if (workspace !== undefined) summary.workspace = workspace;
    else if (headerCwd !== undefined) summary.workspace = headerCwd;
    if (forkOf !== undefined) summary.forkOf = forkOf;
    summaries.push(summary);
  }
  return summaries;
}

/** Session files of the current workspace, newest first.
 *  When `workspaceRoot` is passed, scans its session dir (or `OMA_SESSION_DIR`)
 *  and excludes sessions whose recorded header `cwd` belongs to a different
 *  workspace (guards against shared `OMA_SESSION_DIR` and `sessionDirFor`
 *  slug collisions like `/a/b-c` vs `/a/b/c`). */
export function listSessions(workspaceRoot?: string): SessionSummary[] {
  const targetDir =
    workspaceRoot !== undefined
      ? (process.env.OMA_SESSION_DIR ?? sessionDirFor(workspaceRoot))
      : sessionDir();
  const scanned = scanSessionDir(targetDir);
  const filtered =
    workspaceRoot !== undefined
      ? scanned.filter(
          (s) => s.workspace === undefined || sameWorkspacePath(s.workspace, workspaceRoot),
        )
      : scanned;
  return filtered.sort(compareSessionsNewestFirst);
}

/** Session files across every workspace, newest first. */
export function listAllSessions(): SessionSummary[] {
  if (process.env.OMA_SESSION_DIR) {
    return scanSessionDir(process.env.OMA_SESSION_DIR).sort(compareSessionsNewestFirst);
  }
  const root = sessionsRoot();
  if (!existsSync(root)) return [];
  const summaries: SessionSummary[] = [];
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith("--")) continue;
    summaries.push(...scanSessionDir(join(root, entry)));
  }
  return summaries.sort(compareSessionsNewestFirst);
}

/** The session's current display title (last `title` event), if any. */
export function readSessionTitle(id: string, dir: string = sessionDir()): string | undefined {
  const path = sessionFilePath(id, dir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
  let title: string | undefined;
  for (const line of raw.split("\n")) {
    if (!line.startsWith('{"type":"title"')) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; title?: unknown };
      if (ev.type === "title" && typeof ev.title === "string") title = ev.title;
    } catch {
      /* torn line: the previous title still stands */
    }
  }
  return title;
}

export function appendSessionTitle(id: string, title: string, dir: string = sessionDir()): void {
  const path = sessionFilePath(id, dir);
  if (!existsSync(path)) return;
  appendFileSync(
    path,
    `${JSON.stringify({
      type: "title",
      timestamp: new Date().toISOString(),
      title,
    })}\n`,
  );
}

export function appendSessionSummary(
  id: string,
  summary: string,
  dir: string = sessionDir(),
): void {
  const path = sessionFilePath(id, dir);
  if (!existsSync(path)) return;
  appendFileSync(
    path,
    `${JSON.stringify({
      type: "summary",
      timestamp: new Date().toISOString(),
      summary,
    })}\n`,
  );
}

/** Delete a session file. Returns false when it did not exist. */
export function deleteSession(id: string, dir: string = sessionDir()): boolean {
  const path = sessionFilePath(id, dir);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  lastIdBySession.delete(`${dir}:${id}`);
  return true;
}

/** Rename a session's display title (last-wins title event). */
export function renameSession(id: string, title: string, dir: string = sessionDir()): boolean {
  const path = sessionFilePath(id, dir);
  if (!existsSync(path)) return false;
  appendSessionTitle(id, title, dir);
  return true;
}

/** Append a compaction event after the turn's messages are appended. */
export function appendSessionCompaction(
  id: string,
  summary: string,
  dir: string = sessionDir(),
  replacesEarlierMessages?: boolean,
): void {
  const path = sessionFilePath(id, dir);
  if (!existsSync(path)) return;
  appendFileSync(
    path,
    `${JSON.stringify({
      type: "compaction",
      timestamp: new Date().toISOString(),
      summary,
      ...(replacesEarlierMessages !== undefined ? { replacesEarlierMessages } : {}),
    })}\n`,
  );
}

const lastIdBySession = new Map<string, string | null>();

function readLastMessageId(path: string): string | null {
  let prevId: string | null = null;
  for (const line of readFileSync(path, "utf8").split("\n").reverse()) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line) as { type?: string; id?: string };
      if (evt.type === "message" && evt.id) {
        prevId = evt.id;
        break;
      }
    } catch {
      /* skip */
    }
  }
  return prevId;
}

export function appendSessionMessages(
  id: string,
  cwd: string,
  messages: readonly unknown[],
  dir: string = sessionDir(),
): void {
  mkdirSync(dir, { recursive: true });
  const path = sessionFilePath(id, dir);
  const cacheKey = `${dir}:${id}`;
  if (!existsSync(path)) {
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id,
        timestamp: new Date().toISOString(),
        cwd,
      })}\n`,
    );
  }
  if (!lastIdBySession.has(cacheKey)) {
    lastIdBySession.set(cacheKey, readLastMessageId(path));
  }
  let prevId = lastIdBySession.get(cacheKey) ?? null;
  const lines: string[] = [];
  for (const message of messages) {
    const eventId = crypto.randomUUID();
    lines.push(
      JSON.stringify({
        type: "message",
        id: eventId,
        parentId: prevId,
        timestamp: new Date().toISOString(),
        message,
      }),
    );
    prevId = eventId;
  }
  appendFileSync(path, `${lines.join("\n")}\n`);
  lastIdBySession.set(cacheKey, prevId);
}
