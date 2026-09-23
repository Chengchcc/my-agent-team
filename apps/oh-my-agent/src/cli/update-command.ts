import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import {
  currentVersion,
  fetchGatewayArtifact,
  gatewayPaths,
  omaHome,
  omaVersion,
} from "../core/gateway/artifact.js";

import { isProcessAlive, readDaemon, stopDetachedGateway } from "../core/gateway/daemon.js";
import {
  fetchLatestRelease,
  isNewer,
  type LatestRelease,
  OMA_PACKAGE,
} from "../core/update/release.js";
import { inMonorepoCheckout, startGatewayDetached } from "./gateway-commands.js";

/** Who owns the running oma, i.e. which command updates it. `oma update` only
 *  ever runs the installer it can identify: an unknown install (a hand-copied
 *  binary, another package manager, a distro package) gets the command printed
 *  instead of a guess that could fight the real owner. */
export type InstallOwner =
  | { kind: "bun-global"; spec: string }
  | { kind: "source" }
  | { kind: "unknown" };

/** bun's global install root: `<BUN_INSTALL|~/.bun>/install/global/node_modules`.
 *
 *  `bun add -g` puts the package there and symlinks `bin/<name>` at it, so the
 *  running entry's real path is the test: an entry inside this tree is ours to
 *  reinstall, an entry anywhere else (project node_modules, a checkout) is not.
 *  Same tree the install script documents, so the two agree. */
export function bunGlobalRoot(env: NodeJS.ProcessEnv = process.env): string {
  const install = env.BUN_INSTALL ?? join(homedir(), ".bun");
  return join(install, "install", "global", "node_modules");
}

/** Classify the install. Pure: every ambient fact (the entry path, whether this
 *  build lives in a checkout, the env) is passed in, so callers own detection
 *  and tests are not at the mercy of where the suite runs. */
export function detectInstallOwner(opts: {
  entry?: string | undefined;
  /** True when this build lives in a source checkout — either executed from
   *  src, or a dist that still sits inside the repo. */
  fromCheckout: boolean;
  env?: NodeJS.ProcessEnv;
  version: string;
}): InstallOwner {
  const spec = `${OMA_PACKAGE}@${opts.version}`;
  // A checkout is not updated by reinstalling the package: telling a developer
  // to `bun add -g` the package they are editing would fight their working tree.
  if (opts.fromCheckout) return { kind: "source" };
  if (!opts.entry) return { kind: "unknown" };
  let real: string;
  let root: string;
  try {
    real = realpathSync(opts.entry);
    root = realpathSync(bunGlobalRoot(opts.env ?? process.env));
  } catch {
    return { kind: "unknown" };
  }
  if (real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
    return { kind: "bun-global", spec };
  }
  return { kind: "unknown" };
}

export interface UpdateCommandOptions {
  home?: string;
  /** Pin the target version instead of asking the registry. */
  version?: string;
  /** Report state and stop; no download, no install, no restart. */
  check?: boolean;
  log?: (line: string) => void;
  quiet?: boolean;
  /** Test seam: replaces the registry lookup. */
  fetchLatest?: () => Promise<LatestRelease>;
  /** Test seam: replaces `bun add -g` (returns its exit code). */
  runInstall?: (argv: readonly string[]) => Promise<number>;
}

export interface UpdateState {
  cliVersion: string;
  artifactVersion?: string;
  target: LatestRelease;
}

/** What is installed right now, next to what the registry offers. Shared by
 *  `--check` and the real update so the two reports cannot drift. */
async function resolveState(opts: UpdateCommandOptions): Promise<UpdateState> {
  const home = opts.home ?? omaHome();
  const target = opts.version
    ? { version: opts.version, tag: opts.version }
    : await (opts.fetchLatest ?? (() => fetchLatestRelease()))();
  return { cliVersion: omaVersion(), artifactVersion: currentVersion(home), target };
}

/** Print the two axes separately: the CLI (npm package) and the gateway
 *  artifact (the backend + web tarball) are installed by different steps and
 *  routinely disagree — an up-to-date CLI next to a stale artifact is exactly
 *  the state that produced a gateway which could not start. */
function reportLines(state: UpdateState, home: string): string[] {
  const { cliVersion, artifactVersion, target } = state;
  const lines: string[] = [];
  const cliNote = isNewer(target.version, cliVersion)
    ? "update available"
    : cliVersion === target.version
      ? "current"
      : "newer than the registry (a local build?)";
  lines.push(`oma CLI:           ${cliVersion}  (${cliNote})`);
  lines.push(
    artifactVersion === undefined
      ? `gateway artifact:  none installed (${gatewayPaths(home).versions})`
      : `gateway artifact:  ${artifactVersion}${
          artifactVersion === target.version
            ? "  (current)"
            : isNewer(target.version, artifactVersion)
              ? "  (update available)"
              : "  (newer than the registry)"
        }`,
  );
  lines.push(`newest published:  ${target.version}  (dist-tag ${target.tag})`);
  return lines;
}

/** `oma update`: bring the CLI and the gateway artifact to the newest published
 *  version, and restart a detached gateway so it is not left on the old code.
 *
 *  Refuses to downgrade any axis unless `--version` pins it on purpose. */
export async function runUpdateCommand(opts: UpdateCommandOptions = {}): Promise<number> {
  const home = opts.home ?? omaHome();
  const log = loggerFor(opts);

  let state: UpdateState;
  try {
    state = await resolveState(opts);
  } catch (err: unknown) {
    log(`oma update failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const { cliVersion, artifactVersion, target } = state;

  if (opts.check) {
    log(`oma update --check (home: ${home})`);
    for (const line of reportLines(state, home)) log(line);
    const behind =
      isNewer(target.version, cliVersion) || isNewer(target.version, artifactVersion ?? "0.0.0");
    if (!behind) {
      log("");
      log("up to date");
      return 0;
    }
    log("");
    log("run `oma update` to install it");
    return 1;
  }

  // No silent downgrades. The registry is the newest *published* thing, not
  // necessarily the newest thing this machine has: a checkout of the same
  // version, or a locally built one, must not be replaced by an older release.
  const pinned = opts.version !== undefined;
  if (!pinned && isNewer(cliVersion, target.version)) {
    log(
      `the CLI (${cliVersion}) is newer than the newest published version (${target.version}); nothing to do (pin with --version to force)`,
    );
    return 0;
  }

  log(`oma update: ${cliVersion} -> ${target.version} (dist-tag ${target.tag})`);

  // 1. The artifact first: it is the half that can be broken while the CLI is
  //    fine, and it is what `oma gateway up` needs. A failure here is fatal.
  if (artifactVersion === target.version) {
    log(`gateway artifact ${target.version} is already installed`);
  } else {
    try {
      const result = await fetchGatewayArtifact({ home, version: target.version, log });
      log(
        result.downloaded
          ? `gateway artifact ${target.version} installed`
          : `gateway artifact ${target.version} was already unpacked`,
      );
    } catch (err: unknown) {
      log(`gateway artifact update failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  // 2. The CLI itself. Not fatal: the artifact above is already in place, and
  //    an install that cannot be identified gets instructions instead of a
  //    guess (reinstalling through the wrong owner silently pins the version).
  const owner = detectInstallOwner({
    entry: process.argv[1],
    // Two spellings of "a checkout": executed from src (.ts), or a built dist
    // that still lives inside the repo.
    fromCheckout: import.meta.filename.endsWith(".ts") || inMonorepoCheckout(),
    version: target.version,
  });
  if (!isNewer(target.version, cliVersion)) {
    log(`oma CLI ${cliVersion} is current`);
  } else if (owner.kind === "bun-global") {
    const code = await (opts.runInstall ?? runBunInstall)([
      process.execPath,
      "add",
      "-g",
      owner.spec,
    ]);
    log(code === 0 ? `oma CLI updated to ${target.version}` : `oma CLI install exited ${code}`);
    if (code !== 0) log(`install it by hand: bun add -g ${owner.spec}`);
  } else if (owner.kind === "source") {
    log("running from a checkout: update the code with git pull (the artifact above is current)");
  } else {
    log("cannot tell how this oma was installed; update it with:");
    log(`  bun add -g ${OMA_PACKAGE}@${target.version}`);
  }

  // 3. A detached gateway is still running the old artifact. Restart it onto
  //    the version just installed; a foreground one is the user's to restart.
  await restartRunningGateway({ ...opts, home, version: target.version, log });

  log("");
  log(`done. start it with: oma gateway up`);
  return 0;
}

/** Restart the detached gateway when it is alive AND on a different version.
 *  Never touches a foreground run (it has no pidfile — we do not own it). */
async function restartRunningGateway(
  opts: UpdateCommandOptions & { home: string; version: string; log: (line: string) => void },
): Promise<void> {
  const daemon = readDaemon(opts.home);
  if (!daemon || !isProcessAlive(daemon.pid)) return;
  if (daemon.version === opts.version) {
    opts.log(`the running gateway is already on ${opts.version}`);
    return;
  }
  opts.log(
    `restarting the detached gateway (pid ${daemon.pid}, ${daemon.version} -> ${opts.version})`,
  );
  const stopped = await stopDetachedGateway(opts.home);
  if (!stopped.stopped && !stopped.reason?.startsWith("stale pidfile")) {
    opts.log(`could not stop the old gateway: ${stopped.reason ?? "unknown reason"}`);
    opts.log("stop it yourself, then: oma gateway up -d");
    return;
  }
  const started = await startGatewayDetached({
    home: opts.home,
    version: opts.version,
    log: opts.log,
  });
  if (started !== 0) opts.log("the new version did not become healthy — check the log above");
}

/** `bun add -g`, inherited stdio so the user sees it. `process.execPath` is the
 *  bun running this CLI, so no PATH lookup (and no wrong-bun surprise). */
async function runBunInstall(argv: readonly string[]): Promise<number> {
  const proc = Bun.spawn([...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

function loggerFor(opts: UpdateCommandOptions): (line: string) => void {
  if (opts.log) return opts.log;
  if (opts.quiet) return () => {};
  return (line: string) => {
    process.stdout.write(`${line}\n`);
  };
}

/** `oma update` help text (the args module owns verb discovery). */
export const UPDATE_USAGE = `oma update [--check] [--version <v>]

  (no flags)      install the newest published CLI + gateway artifact, and
                  restart a detached gateway onto the new version
  --check         report what is installed vs what is published; exits 1 when
                  an update is available, 0 when up to date
  --version <v>   pin a version instead of asking the registry (also allows
                  reinstalling a version older than the local one)

Note: 'update' is a reserved first word. To send it as a prompt, use
'oma -p "update ..."'.`;
