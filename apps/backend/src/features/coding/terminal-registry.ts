import { existsSync } from "node:fs";
import { type IExitEvent, type IPty, spawn as ptySpawn } from "bun-pty";

/** tmux-in-the-backend (plan A, no tmux binary): every terminal is a real
 * PTY owned by THIS process. detach (WS drop) never touches the process;
 * close (explicit) kills it; a dead process leaves the entry + buffer as
 * the frozen screen until closed or respawned (tmux remain-on-exit).
 *
 * Backend restart kills every child (kernel SIGHUPs the slave when the
 * master fd closes) — the optional `persist` callback writes a membership
 * snapshot on every spawn/close so boot can RESTORE the layout: shell
 * panes respawn as shells, oma panes as `oma --continue` (context lives in
 * the worktree's session files; only the processes and scrollback die). */

export type TerminalStatus = "running" | "exited";
/** What the pane is FOR — drives respawn/restore shape. "oma" panes
 *  restart as `bash -c "<oma> --continue; exec bash"`. */
export type TerminalKind = "shell" | "oma";

export interface TerminalCommand {
  readonly executable: string;
  readonly args: readonly string[];
  /** Extra env on top of the backend's own (provider keys etc.). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface TerminalInfo {
  readonly terminalId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly cwd: string;
  /** Display hint — set at spawn, renamed by launch-oma. */
  title: string;
  kind: TerminalKind;
  status: TerminalStatus;
  exitCode: number | null;
  startedAt: number;
}

/** The persist-callback snapshot: everything boot-restore needs. Secrets
 *  (env) are deliberately absent — they are re-derived at restore time. */
export interface PersistedTerminal {
  terminalId: string;
  projectId: string;
  agentId: string;
  cwd: string;
  title: string;
  kind: TerminalKind;
}

interface Slot {
  info: TerminalInfo;
  spec: TerminalCommand;
  pty: IPty | null;
  buffer: string;
  dataListeners: Set<(data: string) => void>;
  statusListeners: Set<(info: TerminalInfo) => void>;
}

export interface SpawnInput {
  projectId: string;
  agentId: string;
  cwd: string;
  title?: string;
  kind?: TerminalKind;
  command: TerminalCommand;
  cols?: number;
  rows?: number;
  /** Explicit id (boot restore keeps terminalIds stable across restarts). */
  terminalId?: string;
}

export interface TerminalRegistry {
  spawn(input: SpawnInput): TerminalInfo;
  get(terminalId: string): TerminalInfo | null;
  list(): TerminalInfo[];
  /** Subscribe to live output + status changes. Returns the replay
   *  snapshot (ring buffer tail) for attach-time restore. */
  attach(
    terminalId: string,
    handlers: {
      onData?: (data: string) => void;
      onStatus?: (info: TerminalInfo) => void;
    },
  ): { replay: string; unsubscribe: () => void } | null;
  write(terminalId: string, data: string): boolean;
  resize(terminalId: string, cols: number, rows: number): boolean;
  /** Kill the process AND drop the entry + buffer (tmux kill-pane). */
  close(terminalId: string): boolean;
  /** Re-run the spec in the same entry (tmux respawn-pane -k). An override
   *  spec replaces the stored one (oma panes respawn in the --continue
   *  form even though the original process was a plain shell + injection). */
  respawn(terminalId: string, specOverride?: TerminalCommand): TerminalInfo | null;
  /** Record what the pane became (launch-oma marks it). */
  setKind(terminalId: string, kind: TerminalKind, title?: string): boolean;
  closeAll(): void;
}

/** Ring buffer cap in characters (~1 MiB UTF-8 upper bound). */
const DEFAULT_BUFFER_CAP = 400_000;

function sanitizeEnv(
  extra: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (typeof v === "string") env[k] = v;
  }
  return env;
}

export function createTerminalRegistry(
  deps: {
    idGen?: () => string;
    bufferCap?: number;
    /** Called after every membership/kind mutation (spawn, close, setKind).
     *  Best-effort: a throw must never take the terminal path down. */
    persist?: (snapshot: PersistedTerminal[]) => void;
  } = {},
): TerminalRegistry {
  const idGen =
    deps.idGen ?? (() => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const cap = deps.bufferCap ?? DEFAULT_BUFFER_CAP;
  const slots = new Map<string, Slot>();

  function snapshot(): PersistedTerminal[] {
    return [...slots.values()].map((s) => ({
      terminalId: s.info.terminalId,
      projectId: s.info.projectId,
      agentId: s.info.agentId,
      cwd: s.info.cwd,
      title: s.info.title,
      kind: s.info.kind,
    }));
  }

  function persist(): void {
    if (!deps.persist) return;
    try {
      deps.persist(snapshot());
    } catch {
      // persistence is a best-effort hint, never a hard dependency
    }
  }

  function emit(slot: Slot, data: string): void {
    slot.buffer = (slot.buffer + data).slice(-cap);
    for (const fn of slot.dataListeners) fn(data);
  }

  function startPty(slot: Slot, cols: number, rows: number): void {
    const pty = ptySpawn(slot.spec.executable, [...slot.spec.args], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: slot.info.cwd,
      env: sanitizeEnv(slot.spec.env) as never,
    });
    slot.pty = pty;
    slot.info.status = "running";
    slot.info.exitCode = null;
    slot.info.startedAt = Date.now();
    pty.onData((d: string) => emit(slot, d));
    pty.onExit((ev: IExitEvent) => {
      // A respawned slot may hear the KILLED process's exit after the new
      // one started — only the slot's current pty may mark it exited.
      if (slot.pty !== pty) return;
      // remain-on-exit: the entry and buffer stay as the frozen screen.
      slot.info.status = "exited";
      slot.info.exitCode = ev.exitCode;
      slot.pty = null;
      for (const fn of slot.statusListeners) fn(slot.info);
    });
  }

  function spawn(input: SpawnInput): TerminalInfo {
    if (!existsSync(input.cwd)) {
      throw new Error(`terminal cwd does not exist: ${input.cwd}`);
    }
    const info: TerminalInfo = {
      terminalId: input.terminalId ?? idGen(),
      projectId: input.projectId,
      agentId: input.agentId,
      cwd: input.cwd,
      title: input.title ?? "bash",
      kind: input.kind ?? "shell",
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
    };
    const slot: Slot = {
      info,
      spec: input.command,
      pty: null,
      buffer: "",
      dataListeners: new Set(),
      statusListeners: new Set(),
    };
    slots.set(info.terminalId, slot);
    startPty(slot, input.cols ?? 80, input.rows ?? 24);
    persist();
    return { ...info };
  }

  const slotOf = (id: string): Slot | null => slots.get(id) ?? null;

  return {
    spawn,
    get: (id) => {
      const s = slotOf(id);
      return s ? { ...s.info } : null;
    },
    list: () => [...slots.values()].map((s) => ({ ...s.info })),
    attach(id, handlers) {
      const s = slotOf(id);
      if (!s) return null;
      if (handlers.onData) s.dataListeners.add(handlers.onData);
      if (handlers.onStatus) s.statusListeners.add(handlers.onStatus);
      return {
        replay: s.buffer,
        unsubscribe: () => {
          if (handlers.onData) s.dataListeners.delete(handlers.onData);
          if (handlers.onStatus) s.statusListeners.delete(handlers.onStatus);
        },
      };
    },
    write: (id, data) => {
      const s = slotOf(id);
      if (!s) return false;
      s.pty?.write(data);
      return true;
    },
    resize: (id, cols, rows) => {
      const s = slotOf(id);
      if (!s) return false;
      s.pty?.resize(cols, rows);
      return true;
    },
    close: (id) => {
      const s = slotOf(id);
      if (!s) return false;
      s.pty?.kill();
      slots.delete(id);
      persist();
      return true;
    },
    respawn: (id, specOverride) => {
      const s = slotOf(id);
      if (!s) return null;
      s.pty?.kill();
      if (specOverride) s.spec = specOverride;
      startPty(s, 80, 24);
      return { ...s.info };
    },
    setKind: (id, kind, title) => {
      const s = slotOf(id);
      if (!s) return false;
      s.info.kind = kind;
      if (title !== undefined) s.info.title = title;
      persist();
      return true;
    },
    closeAll: () => {
      for (const s of slots.values()) s.pty?.kill();
      slots.clear();
    },
  };
}
