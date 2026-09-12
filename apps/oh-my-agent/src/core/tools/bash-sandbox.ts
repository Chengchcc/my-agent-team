import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";

/** Bash launch strategy (design: docs/superpowers/specs/2026-09-03-bash-sandbox-design.md).
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
 * OS-level confinement (ADR 0026 semi-trusted baseline). Setsid gives us a
 * killable process group when available. */
export class NullBashSandbox implements BashSandbox {
  readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  spawn(command: string, opts: { cwd: string; env?: Readonly<Record<string, string>> }): BashSpawn {
    const hasSetsid = Bun.which("setsid") !== null;
    const proc = Bun.spawn(
      hasSetsid ? ["setsid", "bash", "-c", command] : ["bash", "-c", command],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd: opts.cwd,
        ...(opts.env ? { env: opts.env } : {}),
      },
    );
    return wrapBunSpawn(proc);
  }
}

/** Linux confinement via bubblewrap: system tree read-only, workspace the only
 * writable bind, /tmp a private tmpfs, network namespace unshared (no
 * egress). bwrap requires setuid or user namespaces; unavailability throws
 * at spawn time (the caller falls back to the approval pipeline). */
export class BwrapBashSandbox implements BashSandbox {
  readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  spawn(command: string, opts: { cwd: string; env?: Readonly<Record<string, string>> }): BashSpawn {
    // Order matters: --tmpfs /tmp would shadow a workspace bound under /tmp,
    // so the workspace bind comes after it (probed on bwrap 0.8).
    const proc = Bun.spawn(
      [
        "bwrap",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
        "--bind",
        this.workspaceRoot,
        this.workspaceRoot,
        "--unshare-net",
        "--die-with-parent",
        "bash",
        "-c",
        command,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd: opts.cwd,
        ...(opts.env ? { env: opts.env } : {}),
      },
    );
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
