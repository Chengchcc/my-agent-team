import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  currentVersion,
  fetchStack,
  installedVersions,
  omaHome,
  omaVersion,
  readSecrets,
  stackPaths,
} from "../core/stack/install.js";
import { readStackManifest } from "../core/stack/manifest.js";
import { upStack } from "../core/stack/supervisor.js";

export interface StackCommandOptions {
  home?: string;
  version?: string;
  quiet?: boolean;
  log?: (line: string) => void;
}

/** A source checkout runs the stack from the repo, so the release artifact it
 *  would download is unused. Only stay quiet there: an explicit CLI call still
 *  fetches. `npm_lifecycle_event` is set while a package's postinstall runs. */
function inMonorepoCheckoutPostinstall(): boolean {
  if (process.env.npm_lifecycle_event !== "postinstall") return false;
  const packageRoot = resolve(import.meta.dirname, "../../..");
  return existsSync(join(packageRoot, "..", "..", "turbo.json"));
}

function loggerFor(opts: StackCommandOptions, stream: "stdout" | "stderr"): (line: string) => void {
  if (opts.log) return opts.log;
  if (opts.quiet) return () => {};
  const write = (line: string): void => {
    process[stream].write(`${line}\n`);
  };
  return write;
}

/** `oma --stack-fetch`: download, verify and unpack the artifact for one
 *  version (default: oma's own) so `--up` can start it. Idempotent. */
export async function runStackFetch(opts: StackCommandOptions = {}): Promise<number> {
  const log = loggerFor(opts, "stderr");
  if (inMonorepoCheckoutPostinstall()) {
    log("stack fetch skipped: source checkout (the stack runs from the repo here)");
    return 0;
  }
  try {
    const result = await fetchStack({
      log,
      ...(opts.home ? { home: opts.home } : {}),
      ...(opts.version ? { version: opts.version } : {}),
    });
    log(`stack ${result.version} ready at ${result.dir}`);
    log("start it with: oma --up");
    return 0;
  } catch (err: unknown) {
    log(`stack fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** `oma --stack-status`: what is installed, which version is current, and
 *  whether the stack answers right now. Never mutates anything. */
export async function runStackStatus(opts: StackCommandOptions = {}): Promise<number> {
  const home = opts.home ?? omaHome();
  const paths = stackPaths(home);
  const log = loggerFor(opts, "stdout");
  const versions = installedVersions(home);
  const current = currentVersion(home);

  log(`stack home: ${paths.home}`);
  log(`versions:   ${versions.length > 0 ? versions.join(", ") : "(none installed)"}`);
  log(`current:    ${current ?? "(none)"}`);
  if (versions.length === 0) {
    log(`install one: oma --stack-fetch   (oma ${omaVersion()})`);
    return 1;
  }

  const version = opts.version ?? current ?? versions[versions.length - 1] ?? "";
  const dir = join(paths.versions, version);
  const manifestPath = join(dir, "stack.json");
  if (!existsSync(manifestPath)) {
    log(`version ${version} is incomplete at ${dir} — re-run: oma --stack-fetch`);
    return 1;
  }

  const manifest = readStackManifest(manifestPath);
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
  log("start it with: oma --up");
  return 1;
}

/** `oma --up`: fetch the version if it is missing, then run the whole stack in
 *  the foreground (Ctrl-C stops it, children are signalled in reverse order). */
export async function runStackUp(opts: StackCommandOptions = {}): Promise<number> {
  const home = opts.home ?? omaHome();
  const log = loggerFor(opts, "stdout");
  const version = opts.version ?? currentVersion(home) ?? omaVersion();
  const dir = join(stackPaths(home).versions, version);

  if (!existsSync(join(dir, "stack.json"))) {
    log(`stack ${version} is not installed yet — fetching it`);
    const code = await runStackFetch({ ...opts, version, log });
    if (code !== 0) return code;
  }

  try {
    return await upStack({
      home,
      version,
      log,
      onReady: (handle) => {
        const web = handle.manifest.components.find((component) => component.port === 3001);
        log("");
        log(
          `stack ${handle.manifest.version} is up (${handle.manifest.components.length} processes)`,
        );
        log(`open http://127.0.0.1:${web?.port ?? 3001}/login`);
        if (handle.secrets.MOCK_PASSWORD) log(`login: user-001 / ${handle.secrets.MOCK_PASSWORD}`);
        log("Ctrl-C stops the stack");
      },
    });
  } catch (err: unknown) {
    log(`stack failed to start: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
