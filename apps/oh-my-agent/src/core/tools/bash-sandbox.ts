import { existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Bash launch strategy (docs/architecture/security/bash-sandbox.md).
 * A sandbox wraps the actual spawn so the OS enforces filesystem + network
 * boundaries on the running process and its children. Null = current
 * unconstrained behavior; Bwrap (Linux) / Seatbelt (macOS) = OS confinement. */

/** Same shape as the Bun spawn bash.ts consumes: streamable stdout/stderr,
 * exit promise, process-group kill. */
export interface BashSpawn {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
}

export interface BashSandbox {
  /** Workspace root the command is (eventually) confined to. */
  readonly workspaceRoot: string;
  spawn(command: string, opts: { cwd: string; env?: Readonly<Record<string, string>> }): BashSpawn;
}
function wrapBunSpawn(proc: Bun.Subprocess): BashSpawn {
  const { stdout, stderr } = proc;
  if (!stdout || !stderr) throw new Error("bash spawn lost its stdout/stderr pipes");
  // Bun types stderr as ReadableStream | number (fd) for some spawn shapes;
  // stdout:"pipe"/stderr:"pipe" guarantees the stream variant.
  const out = stdout as ReadableStream<Uint8Array>;
  const err = stderr as ReadableStream<Uint8Array>;
  return {
    stdout: out,
    stderr: err,
    exited: proc.exited,
    kill: () => {
      // SIGKILL (not the default SIGTERM): sandbox-exec may be a wrapper that
      // execs child bash — a TERM to the wrapper does not guarantee the child
      // dies. SIGKILL to the (usually exec'd) command plus group-kill covers
      // both exec- and fork-typed wrappers.
      proc.kill("SIGKILL");
      try {
        process.kill(-proc.pid!, "SIGKILL");
      } catch {
        /* not a group leader */
      }
    },
  };
}

/** Current behavior, made explicit: plain `bash -c` with a validated cwd, no
 * OS-level confinement (ADR 0026 semi-trusted baseline).
 *
 * Terminal isolation (non-negotiable): a headless command must never share
 * the TUI's controlling terminal. `detached: true` is a portable setsid (new
 * session, no controlling tty — verified sid==pid on Bun), so /dev/tty opens
 * FAIL instead of painting a password prompt over the TUI and stealing
 * keystrokes from the editor (a real scp session did exactly that: ssh's
 * readpassphrase and the TUI competed for the same fd — the ESC of a Kitty
 * CSI-u sequence went to ssh, the printable tail "[99;1:3u" was typed into
 * the editor as garbage). `stdin: "ignore"` closes the stdin half of the same
 * hole. Interactive commands belong in the pty console (pty: true). The old
 * Linux-only `setsid` binary wrapper is gone: macOS has no setsid, so it
 * silently degraded there. */
export class NullBashSandbox implements BashSandbox {
  readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  spawn(command: string, opts: { cwd: string; env?: Readonly<Record<string, string>> }): BashSpawn {
    const proc = Bun.spawn(["bash", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      detached: true,
      cwd: opts.cwd,
      ...(opts.env ? { env: opts.env } : {}),
    });
    return wrapBunSpawn(proc);
  }
}

/** Workspace-relative config files that remain read-only even inside a
 *  writable workspace bind so a sandboxed command cannot tamper with MCP
 *  endpoints, plugins, or workspace policy settings. */
const BWRAP_RO_WORKSPACE_FILES = [".mcp.json", ".oma/plugins.json", ".oma/settings.json"] as const;

/** Build the bwrap argv for a sandboxed bash command. Exported so security
 *  invariants (--unshare-pid, sensitive dir masking, protected workspace files,
 *  OMA_DENY_WRITE_PATHS masking) stay unit-testable even on hosts without bwrap. */
export function buildBwrapArgs(
  workspaceRoot: string,
  command: string,
  denyPathsRaw: string | undefined = process.env.OMA_DENY_WRITE_PATHS,
): string[] {
  const ws = resolve(workspaceRoot);
  // Order matters: --tmpfs mounts on /tmp, /root, /home come BEFORE the
  // workspace --bind so a workspace living under /tmp or /root stays mounted
  // while sibling host secrets (~/.ssh, ~/.oma, ~/.env) stay masked.
  const args: string[] = [
    "bwrap",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--unshare-pid",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
  ];
  for (const sensitiveDir of ["/root", "/home"]) {
    if (existsSync(sensitiveDir)) {
      args.push("--tmpfs", sensitiveDir);
    }
  }
  args.push("--bind", ws, ws);

  // Re-bind protected workspace files read-only when present.
  for (const rel of BWRAP_RO_WORKSPACE_FILES) {
    const full = join(ws, rel);
    if (existsSync(full)) {
      args.push("--ro-bind", full, full);
    }
  }

  // Mask explicit OMA_DENY_WRITE_PATHS directories/files so commands cannot
  // read or write them even through the ro root mount.
  const denyRules = (denyPathsRaw ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  for (const rule of denyRules) {
    const target = resolve(rule.endsWith("/") ? rule.slice(0, -1) : rule);
    // Do not shadow the workspace root itself or an ancestor containing it.
    if (target === ws || ws.startsWith(`${target}/`)) continue;
    if (!existsSync(target)) continue;
    try {
      if (statSync(target).isDirectory()) {
        args.push("--tmpfs", target);
      } else {
        args.push("--ro-bind", "/dev/null", target);
      }
    } catch {
      /* unreadable target already unreachable */
    }
  }

  args.push("--unshare-net", "--die-with-parent", "bash", "-c", command);
  return args;
}

/** Linux confinement via bubblewrap: system tree read-only, PID & network
 *  namespaces unshared, host home trees masked, workspace writable except
 *  protected config files. bwrap requires setuid or user namespaces;
 *  unavailability throws at spawn time (the caller falls back to approvals). */
export class BwrapBashSandbox implements BashSandbox {
  readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  spawn(command: string, opts: { cwd: string; env?: Readonly<Record<string, string>> }): BashSpawn {
    const proc = Bun.spawn(buildBwrapArgs(this.workspaceRoot, command), {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      detached: true,
      cwd: opts.cwd,
      ...(opts.env ? { env: opts.env } : {}),
    });
    return wrapBunSpawn(proc);
  }
}

/** Seatbelt profile template (macOS). `(deny default)` + explicit allows:
 * process execution, system-wide reads, writes only inside the workspace (plus
 * /private/tmp and the character devices bash redirects to); network denied.
 * Placeholder: {WORKSPACE} — the workspace root, realpath-resolved and escaped
 * for scheme string literals.
 *
 * Three things that are NOT negotiable here (all learned the hard way on
 * macOS 26 — before them the confinement was silently OFF or bash aborted):
 *
 * 1. `(allow file-ioctl)`, NEVER `file-ioctl*`: the star form makes the parser
 *    report "unbound variable: file-ioctl*" and sandbox-exec exits 65, i.e.
 *    every command fails while the tool still claims to be sandboxed.
 * 2. `(allow file-read*)` rather than an enumerated read list: bash aborts
 *    (SIGABRT, no diagnostic) unless `/` and the workspace's whole ancestor
 *    chain are readable, and dyld's cache paths move between macOS releases.
 *    Reading everything matches the Linux strategy, where bwrap does
 *    `--ro-bind / /`: the enforced boundaries are the WRITE set and the
 *    network, both of which stay restricted below.
 * 3. The device literals: without them `2>/dev/null` is denied, which does not
 *    fail loudly — bash writes "Operation not permitted" to the real stderr
 *    and continues, so command semantics silently drift from unsandboxed. */
const SEATBELT_PROFILE = `(version 1)
(deny default)
(allow process*)
(allow file-read*)
(allow file-write*
  (subpath "{WORKSPACE}")
  (subpath "/private/tmp")
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (literal "/dev/tty")
  (subpath "/dev/fd"))
(allow file-ioctl)
(allow sysctl*)
(allow mach-lookup)
(deny network*)
`;

/** macOS confinement via sandbox-exec (Seatbelt). The profile is written to
 * <workspace>/.oma/ per spawn and removed on exit. sandbox-exec availability
 * throws at spawn time (the caller falls back to the approval pipeline). */
export class SeatbeltBashSandbox implements BashSandbox {
  readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  spawn(command: string, opts: { cwd: string; env?: Readonly<Record<string, string>> }): BashSpawn {
    const bashPath = Bun.which("bash") ?? "/bin/bash";
    // Seatbelt string literals need escaped backslashes and quotes.
    const sbEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    // The kernel matches vnode paths, so a symlinked workspace root must be
    // canonicalized or the write allowance never matches the real tree.
    let workspace = this.workspaceRoot;
    try {
      workspace = realpathSync(this.workspaceRoot);
    } catch {
      /* not created yet; the raw path is the best available literal */
    }
    const profile = SEATBELT_PROFILE.replaceAll("{WORKSPACE}", sbEscape(workspace));
    const profileDir = `${this.workspaceRoot}/.oma`;
    mkdirSync(profileDir, { recursive: true });
    const profilePath = `${profileDir}/.seatbelt-${crypto.randomUUID().slice(0, 8)}.sb`;
    writeFileSync(profilePath, profile);
    const proc = Bun.spawn(["sandbox-exec", "-f", profilePath, bashPath, "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      detached: true,
      cwd: opts.cwd,
      ...(opts.env ? { env: opts.env } : {}),
    });
    const cleanup = () => {
      try {
        rmSync(profilePath);
      } catch {
        /* already gone */
      }
    };
    return {
      stdout: proc.stdout,
      stderr: proc.stderr,
      exited: proc.exited.then((code) => {
        cleanup();
        return code;
      }),
      kill: () => {
        // Same SIGKILL-first semantics as wrapBunSpawn (macOS sandbox-exec
        // typically execs the command; SIGKILL to it kills the bash tree).
        proc.kill("SIGKILL");
        try {
          process.kill(-proc.pid!, "SIGKILL");
        } catch {
          /* not a group leader */
        }
      },
    };
  }
}

/** Pick the launch strategy. enabled=false → Null (explicit current
 * behavior); Linux → Bwrap, macOS → Seatbelt, each when its tool is
 * installed. Throws on enabled-but-missing so the caller can surface
 * "sandbox requested but unavailable" instead of silently running
 * unconstrained. */
export function resolveBashSandbox(opts: {
  workspaceRoot: string;
  enabled: boolean;
  platform?: NodeJS.Platform;
}): BashSandbox {
  if (!opts.enabled) return new NullBashSandbox(opts.workspaceRoot);
  const platform = opts.platform ?? process.platform;
  if (platform === "linux") {
    if (Bun.which("bwrap") === null) {
      throw new Error(
        "bash sandbox requested but bubblewrap is not installed (apt install bubblewrap)",
      );
    }
    return new BwrapBashSandbox(opts.workspaceRoot);
  }
  if (platform === "darwin") {
    if (Bun.which("sandbox-exec") === null) {
      throw new Error("bash sandbox requested but sandbox-exec is not available");
    }
    return new SeatbeltBashSandbox(opts.workspaceRoot);
  }
  throw new Error(`bash sandbox not implemented for platform ${platform}`);
}
