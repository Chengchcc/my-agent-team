import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  currentVersion,
  fetchGatewayArtifact,
  gatewayPaths,
  installedVersions,
  omaHome,
  omaVersion,
  readSecrets,
} from "../core/gateway/artifact.js";
import {
  isProcessAlive,
  readDaemon,
  startDetachedGateway,
  stopDetachedGateway,
  tailDaemonLog,
} from "../core/gateway/daemon.js";
import { readGatewayManifest } from "../core/gateway/manifest.js";
import { runGateway } from "../core/gateway/supervisor.js";

/** The gateway domain's verbs. `oma gateway <verb>` is the CLI surface for
 *  backend + web: fetch their artifact, run it, report on it. */
export const GATEWAY_VERBS = ["up", "down", "fetch", "status"] as const;
export type GatewayCommand = (typeof GATEWAY_VERBS)[number];

export const GATEWAY_USAGE = `oma gateway <command>

  up        start backend + web; stays in the foreground (Ctrl-C stops it)
  up -d     same, but detached: returns once it is healthy
  down      stop a detached gateway
  fetch     download, verify and unpack the gateway artifact for a version
  status    which version is installed, is it running, is it answering

  --version <v>   artifact version for up/fetch (default: oma's own)

Note: 'gateway' is a reserved first word. To send it as a prompt, use
'oma -p "gateway ..."'.`;

export function isGatewayCommand(value: string): value is GatewayCommand {
  for (const verb of GATEWAY_VERBS) {
    if (verb === value) return true;
  }
  return false;
}

export interface GatewayCommandOptions {
  home?: string;
  version?: string;
  /** `up -d`: run detached, with a pidfile and a log file. */
  detach?: boolean;
  quiet?: boolean;
  log?: (line: string) => void;
}

/** A source checkout runs the gateway from the repo, so the release artifact it
 *  would download is unused. Only stay quiet there: an explicit CLI call still
 *  fetches. `npm_lifecycle_event` is set while a package's postinstall runs. */
function inMonorepoCheckoutPostinstall(): boolean {
  if (process.env.npm_lifecycle_event !== "postinstall") return false;
  // src/cli (dist/cli) is TWO levels under the package root — unlike
  // core/gateway/*, which sits three. Getting this wrong made the guard a no-op.
  const packageRoot = resolve(import.meta.dirname, "../..");
  return existsSync(join(packageRoot, "..", "..", "turbo.json"));
}

function loggerFor(
  opts: GatewayCommandOptions,
  stream: "stdout" | "stderr",
): (line: string) => void {
  if (opts.log) return opts.log;
  if (opts.quiet) return () => {};
  const write = (line: string): void => {
    process[stream].write(`${line}\n`);
  };
  return write;
}

/** `oma gateway fetch`: download, verify and unpack the artifact for one
 *  version (default: oma's own) so `up` can start it. Idempotent. */
export async function runGatewayFetch(opts: GatewayCommandOptions = {}): Promise<number> {
  const log = loggerFor(opts, "stderr");
  if (inMonorepoCheckoutPostinstall()) {
    log("gateway fetch skipped: source checkout (the gateway runs from the repo here)");
    return 0;
  }
  try {
    const result = await fetchGatewayArtifact({
      log,
      ...(opts.home ? { home: opts.home } : {}),
      ...(opts.version ? { version: opts.version } : {}),
    });
    log(`gateway ${result.version} ready at ${result.dir}`);
    log("start it with: oma gateway up");
    return 0;
  } catch (err: unknown) {
    log(`gateway fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** `oma gateway status`: what is installed, which version is current, and
 *  whether the gateway answers right now. Never mutates anything. */
export async function runGatewayStatus(opts: GatewayCommandOptions = {}): Promise<number> {
  const home = opts.home ?? omaHome();
  const paths = gatewayPaths(home);
  const log = loggerFor(opts, "stdout");
  const versions = installedVersions(home);
  const current = currentVersion(home);

  log(`gateway home: ${paths.home}`);
  log(`versions:   ${versions.length > 0 ? versions.join(", ") : "(none installed)"}`);
  log(`current:    ${current ?? "(none)"}`);
  if (versions.length === 0) {
    log(`install one: oma gateway fetch   (oma ${omaVersion()})`);
    return 1;
  }

  const version = opts.version ?? current ?? versions[versions.length - 1] ?? "";
  const dir = join(paths.versions, version);
  const manifestPath = join(dir, "gateway.json");
  if (!existsSync(manifestPath)) {
    log(`version ${version} is incomplete at ${dir} — re-run: oma gateway fetch`);
    return 1;
  }

  const daemon = readDaemon(home);
  if (daemon && isProcessAlive(daemon.pid)) {
    log(`running:    detached, pid ${daemon.pid}, since ${daemon.startedAt}`);
    log(`log:        ${daemon.logPath}`);
  } else if (daemon) {
    log(`running:    no (stale pidfile for pid ${daemon.pid}; 'oma gateway down' clears it)`);
  } else {
    log("running:    no pidfile (started in the foreground, or not started)");
  }

  const manifest = readGatewayManifest(manifestPath);
  let allUp = true;
  for (const component of manifest.components) {
    if (!component.healthUrl) continue;
    let state = "down";
    try {
      const res = await fetch(component.healthUrl, { signal: AbortSignal.timeout(2000) });
      if (res.ok) state = "up";
    } catch {
      // down
    }
    if (state === "down") allUp = false;
    log(`${component.name.padEnd(8)} ${state.padEnd(4)} ${component.healthUrl}`);
  }

  const password = readSecrets(home).MOCK_PASSWORD;
  if (allUp) {
    log(`login: http://127.0.0.1:3001/login  (user-001 / ${password ?? "?"})`);
    return 0;
  }
  log("start it with: oma gateway up");
  return 1;
}

/** `oma gateway up`: fetch the version if it is missing, then run the whole gateway in
 *  the foreground (Ctrl-C stops it, children are signalled in reverse order). */
export async function runGatewayUp(opts: GatewayCommandOptions = {}): Promise<number> {
  const home = opts.home ?? omaHome();
  const log = loggerFor(opts, "stdout");
  const version = opts.version ?? currentVersion(home) ?? omaVersion();
  const dir = join(gatewayPaths(home).versions, version);

  if (!existsSync(join(dir, "gateway.json"))) {
    log(`gateway ${version} is not installed yet — fetching it`);
    const code = await runGatewayFetch({ ...opts, version, log });
    if (code !== 0) return code;
  }

  if (opts.detach) return startGatewayDetached({ ...opts, home, version, log });

  try {
    return await runGateway({
      home,
      version,
      log,
      onReady: (handle) => {
        const web = handle.manifest.components.find((component) => component.port === 3001);
        log("");
        log(
          `gateway ${handle.manifest.version} is up (${handle.manifest.components.length} processes)`,
        );
        log(`open http://127.0.0.1:${web?.port ?? 3001}/login`);
        if (handle.secrets.MOCK_PASSWORD) log(`login: user-001 / ${handle.secrets.MOCK_PASSWORD}`);
        log("Ctrl-C stops the gateway");
      },
    });
  } catch (err: unknown) {
    log(`gateway failed to start: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** `oma gateway down`: stop whatever `up -d` started. */
export async function runGatewayDown(opts: GatewayCommandOptions = {}): Promise<number> {
  const home = opts.home ?? omaHome();
  const log = loggerFor(opts, "stdout");
  const result = await stopDetachedGateway(home);
  if (result.stopped) {
    log(`gateway stopped${result.reason ? ` (${result.reason})` : ""}`);
    return 0;
  }
  log(`nothing stopped: ${result.reason ?? "unknown reason"}`);
  return result.reason?.startsWith("stale pidfile") ? 0 : 1;
}

/** Relaunch this CLI in the background and wait until it answers, so the command
 *  reports the truth instead of "started something, maybe". */
async function startGatewayDetached(
  opts: GatewayCommandOptions & { home: string; version: string; log: (line: string) => void },
): Promise<number> {
  const entry = process.argv[1];
  if (!entry) {
    opts.log("cannot detach: no CLI entry path in argv");
    return 1;
  }
  const command = [process.execPath, entry, "gateway", "up"];
  if (opts.version) command.push("--version", opts.version);

  const daemon = await startDetachedGateway({
    home: opts.home,
    version: opts.version,
    command,
  });
  opts.log(`gateway ${opts.version} starting detached (pid ${daemon.pid})`);
  opts.log(`log: ${daemon.logPath}`);

  const manifest = readGatewayManifest(
    join(gatewayPaths(opts.home).versions, opts.version, "gateway.json"),
  );
  const web = manifest.components.find((component) => component.port === 3001);
  const healthUrl = web?.healthUrl;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(daemon.pid)) break;
    if (healthUrl) {
      try {
        const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const password = readSecrets(opts.home).MOCK_PASSWORD;
          opts.log("");
          opts.log(`gateway ${opts.version} is up in the background (pid ${daemon.pid})`);
          opts.log(`open http://127.0.0.1:${web?.port ?? 3001}/login`);
          if (password) opts.log(`login: user-001 / ${password}`);
          opts.log("stop it with: oma gateway down");
          return 0;
        }
      } catch {
        // not listening yet
      }
    }
    await new Promise((res) => {
      setTimeout(res, 500);
    });
  }

  opts.log("gateway did not become healthy in 60s — last log lines:");
  for (const line of tailDaemonLog(opts.home)) opts.log(`  ${line}`);
  opts.log("stop it with: oma gateway down");
  return 1;
}

/** `oma gateway <verb>`: single entry point so the CLI owns one code path. */
export async function runGatewayCommand(
  verb: GatewayCommand,
  opts: GatewayCommandOptions = {},
): Promise<number> {
  if (verb === "up") return runGatewayUp(opts);
  if (verb === "down") return runGatewayDown(opts);
  if (verb === "fetch") return runGatewayFetch(opts);
  return runGatewayStatus(opts);
}
