import { existsSync, readFileSync, statfsSync, statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  currentVersion,
  gatewayPaths,
  omaHome,
  omaVersion,
  readSecrets,
  releaseLocation,
} from "./artifact.js";
import { daemonPaths, isProcessAlive, readDaemon } from "./daemon.js";
import { readGatewayManifest } from "./manifest.js";
import { resolveOmaBin } from "./supervisor.js";

/** One diagnosis line: what was checked, what was found, and how to fix it. */
export interface GatewayCheck {
  id: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface DoctorOptions {
  home?: string;
  /** Seam for tests: replaces the `oma --list-models` probe. */
  probeModels?: () => Promise<{ providers: string[] }>;
  /** Seam for tests: replaces the release HEAD probe. Returns the HTTP status,
   *  or undefined when the host could not be reached. */
  probeRelease?: (url: string) => Promise<number | undefined>;
}

/** Provider env names oma's builtin catalog knows (the product backend
 *  forwards every *_API_KEY, but these work with no models.yml at all). */
const BUILTIN_KEY_ENVS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
];

/** Hosts that are not reachable from another machine. */
const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"];

async function probeRunnableProviders(): Promise<{ providers: string[] }> {
  const entry = resolveOmaBin();
  const proc = Bun.spawn([entry, "--list-models"], {
    // Exactly the switches the product backend uses for its children, so the
    // answer matches what a Run would see.
    env: { ...process.env, OMA_WORKSPACE_CATALOG: "0" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) return { providers: [] };
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || !("models" in parsed)) {
    return { providers: [] };
  }
  const models = parsed.models;
  if (!Array.isArray(models)) return { providers: [] };
  const seen: Record<string, true> = {};
  for (const model of models) {
    if (typeof model !== "object" || model === null || !("id" in model)) continue;
    const id = model.id;
    if (typeof id !== "string") continue;
    const provider = id.split("/")[0];
    if (provider) seen[provider] = true;
  }
  return { providers: Object.keys(seen).sort() };
}

/** `{status:"ok"}` from :3000/health is our backend; anything else on that port
 *  is somebody else's process. */
async function backendAnswers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null && "status" in body;
  } catch {
    return false;
  }
}

async function anyPortAnswers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

/** Diagnose why a gateway may not be able to run anything: artifact, tools,
 *  catalog source, runnable providers, ports, and the per-run oma binary. */
export async function diagnoseGateway(opts: DoctorOptions = {}): Promise<GatewayCheck[]> {
  const home = opts.home ?? omaHome();
  const paths = gatewayPaths(home);
  const checks: GatewayCheck[] = [];

  // 1. artifact
  const version = currentVersion(home) ?? omaVersion();
  const dir = join(paths.versions, version);
  const manifestPath = join(dir, "gateway.json");
  let manifest: ReturnType<typeof readGatewayManifest> | undefined;
  if (existsSync(manifestPath)) {
    manifest = readGatewayManifest(manifestPath);
    checks.push({
      id: "artifact",
      ok: true,
      detail: `${version} installed (${manifest.components.length} components) at ${dir}`,
    });
  } else {
    // A source checkout carries the repo's own version, which was never
    // published: pointing at it would 404, so say what to do instead.
    const fromSource = import.meta.filename.endsWith(".ts");
    checks.push({
      id: "artifact",
      ok: false,
      detail: `no gateway artifact for ${version} at ${dir}`,
      fix: fromSource
        ? "running from a checkout: fetch a released version (oma gateway fetch --version <released>), or run the stack from the repo"
        : `oma gateway fetch --version ${version}`,
    });
  }

  // 2. unpack tools (only needed by fetch)
  const missingTools = ["tar", "zstd"].filter((tool) => !Bun.which(tool));
  checks.push({
    id: "tools",
    ok: missingTools.length === 0,
    detail:
      missingTools.length === 0
        ? "tar and zstd are on PATH"
        : `missing: ${missingTools.join(", ")}`,
    fix: missingTools.length > 0 ? `install: ${missingTools.join(" ")}` : undefined,
  });

  // 3. catalog source — informational, but it is the usual reason a custom
  //    provider is invisible: product children read ONLY $OMA_HOME/models.yml.
  const catalogHome = process.env.OMA_HOME;
  const customCatalog = catalogHome ? join(catalogHome, "models.yml") : undefined;
  if (customCatalog) {
    checks.push({
      id: "catalog",
      ok: true,
      detail: existsSync(customCatalog)
        ? `custom catalog: ${customCatalog}`
        : `OMA_HOME is set but ${customCatalog} does not exist (builtin providers only)`,
    });
  } else {
    checks.push({
      id: "catalog",
      ok: true,
      detail: "OMA_HOME is unset: no models.yml is read, so only builtin providers can be used",
      fix: "to use a custom provider: put models.yml in a directory and start the gateway with OMA_HOME pointing at it",
    });
  }

  // 4. provider credentials present in THIS environment (what a gateway
  //    started from here would hand to the backend).
  const present = BUILTIN_KEY_ENVS.filter((key) => (process.env[key] ?? "").length > 0);
  checks.push({
    id: "keys",
    ok: present.length > 0,
    detail:
      present.length > 0
        ? `provider keys in this environment: ${present.join(", ")}`
        : "no builtin provider key in this environment",
    ...(present.length === 0
      ? {
          fix: "add one in the web UI (Settings -> Provider keys: stored server-side, no restart), or export it and restart the gateway",
        }
      : {}),
  });

  // 5. the decisive one: what can actually run, asked the way the backend asks.
  let providers: string[];
  try {
    providers = (await (opts.probeModels ?? probeRunnableProviders)()).providers;
  } catch (err: unknown) {
    providers = [];
    checks.push({
      id: "models",
      ok: false,
      detail: `could not list models: ${err instanceof Error ? err.message : String(err)}`,
      fix: "check that oma runs: oma --list-models",
    });
  }
  if (providers.length > 0) {
    checks.push({ id: "models", ok: true, detail: `runnable providers: ${providers.join(", ")}` });
  } else if (checks.every((c) => c.id !== "models")) {
    checks.push({
      id: "models",
      ok: false,
      detail: "no runnable model: an agent Run would fail here",
      fix: "for a builtin provider add its key in the web UI (Settings -> Provider keys); for a custom provider put models.yml where OMA_HOME points and restart",
    });
  }

  // 6. download channel — only matters when the artifact is missing.
  if (!manifest) {
    const { sums } = releaseLocation(version, process.env);
    const probe =
      opts.probeRelease ??
      (async (url: string): Promise<number | undefined> => {
        try {
          const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
          return res.status;
        } catch {
          return undefined;
        }
      });
    const status = await probe(sums);
    if (status === undefined) {
      checks.push({
        id: "download",
        ok: false,
        detail: `cannot reach the release host: ${sums}`,
        fix: "check the network/proxy; a slow link shows up as a stalled download when fetching",
      });
    } else {
      // Any HTTP answer means the channel works; a 404 just means this version
      // was never published (routine in a source checkout).
      checks.push({
        id: "download",
        ok: true,
        detail:
          status === 200
            ? `release reachable: ${sums}`
            : `release host reachable, but ${version} has no release (HTTP ${status})`,
      });
    }
  }

  // 7. secrets: present, parseable, and not readable by anyone else.
  const secretsPath = paths.secrets;
  if (!existsSync(secretsPath)) {
    checks.push({
      id: "secrets",
      ok: true,
      detail: `no secrets yet at ${secretsPath} (generated on first up)`,
    });
  } else {
    const mode = statSync(secretsPath).mode & 0o777;
    let parsed: Record<string, string> | undefined;
    let parseError: string | undefined;
    try {
      parsed = readSecrets(home);
    } catch (err: unknown) {
      parseError = err instanceof Error ? err.message : String(err);
    }
    if (parseError) {
      checks.push({
        id: "secrets",
        ok: false,
        detail: `${secretsPath} is unreadable: ${parseError}`,
        fix: `fix or delete ${secretsPath} (a new one is generated on the next up)`,
      });
    } else {
      const keys = Object.keys(parsed ?? {});
      checks.push({
        id: "secrets",
        ok: mode === 0o600,
        detail: `${secretsPath} holds ${keys.join(", ") || "nothing"} (mode ${mode.toString(8)})`,
        fix: mode === 0o600 ? undefined : `chmod 600 ${secretsPath}`,
      });
    }
  }

  // 8. data directory: the backend writes its DB, workspaces and workflows here.
  const dataDir = paths.data;
  if (!existsSync(dataDir)) {
    checks.push({
      id: "data-dir",
      ok: true,
      detail: `${dataDir} does not exist yet (created on first up)`,
    });
  } else {
    let writable = true;
    const probe = join(dataDir, ".doctor-probe");
    try {
      await writeFile(probe, "");
      await rm(probe, { force: true });
    } catch {
      writable = false;
    }
    let freeMb: number;
    try {
      const fs = statfsSync(dataDir);
      freeMb = Math.round((Number(fs.bavail) * Number(fs.bsize)) / (1024 * 1024));
    } catch {
      freeMb = -1;
    }
    const lowSpace = freeMb >= 0 && freeMb < 500;
    checks.push({
      id: "data-dir",
      ok: writable && !lowSpace,
      detail: writable
        ? `${dataDir} (free ${freeMb >= 0 ? `${freeMb}MB` : "unknown"})`
        : `${dataDir} is not writable`,
      fix: writable && !lowSpace ? undefined : `free space or fix ownership: ${dataDir}`,
    });
  }

  // 9. ports: is our stack answering, or is something else sitting on them?
  const backendUp = await backendAnswers("http://127.0.0.1:3000/health");
  const webAnswers = await anyPortAnswers("http://127.0.0.1:3001/login");
  const daemon = readDaemon(home);
  const detached =
    daemon && isProcessAlive(daemon.pid) ? `detached, pid ${daemon.pid}` : "not detached";
  if (backendUp) {
    checks.push({
      id: "ports",
      ok: true,
      detail: `${detached}; our backend answers on 3000${webAnswers ? " and 3001 answers too" : ""}`,
    });
  } else if (webAnswers) {
    checks.push({
      id: "ports",
      ok: false,
      detail: `something answers on 3001 but 3000 is not our backend (${detached})`,
      fix: "stop whatever holds 3001, or start the gateway with different ports",
    });
  } else {
    checks.push({ id: "ports", ok: true, detail: `${detached}; ports quiet` });
  }

  // 10. the last start's log: migration failures are the classic first-boot
  //     death and they only live here.
  const logPath = daemonPaths(home).log;
  if (existsSync(logPath)) {
    const tail = readFileSync(logPath, "utf8").split("\n").slice(-200);
    const failure = tail.find(
      (line) =>
        line.includes("_journal") ||
        /\bmigrate\b/i.test(line) ||
        line.includes("SQLITE_") ||
        line.includes("no such table"),
    );
    checks.push({
      id: "last-start",
      ok: failure === undefined,
      detail:
        failure === undefined
          ? `${logPath}: no migration or SQLite errors in the last start`
          : `${logPath} shows: ${failure.trim().slice(0, 120)}`,
      fix: failure === undefined ? undefined : `read ${logPath} for the full start log`,
    });
  } else {
    checks.push({ id: "last-start", ok: true, detail: "no detached start log yet" });
  }

  // 11. exposure: the artifact decides what the components bind.
  if (manifest) {
    const hosts: string[] = [];
    for (const component of manifest.components) {
      const host = component.env.HOSTNAME ?? component.env.BACKEND_HOST;
      hosts.push(host ?? "unset(0.0.0.0)");
    }
    const exposed = hosts.filter((host) => !LOOPBACK_HOSTS.includes(host));
    const tokenIsDefault = (() => {
      try {
        const token = readSecrets(home).BACKEND_AUTH_TOKEN;
        return token === undefined || token === "dev-token";
      } catch {
        return true;
      }
    })();
    if (exposed.length === 0) {
      checks.push({ id: "exposure", ok: true, detail: "all components bind loopback" });
    } else {
      checks.push({
        id: "exposure",
        ok: !tokenIsDefault,
        detail: tokenIsDefault
          ? `components bind non-loopback (${exposed.join(", ")}) while the auth token is missing or the documented default`
          : `components bind non-loopback (${exposed.join(", ")})`,
        fix: tokenIsDefault
          ? "set a random token before exposing this gateway, and see docs/architecture/security"
          : undefined,
      });
    }
  }

  // 12. which password wins: the console's hash or the launcher's secret.
  if (backendUp) {
    try {
      const token = readSecrets(home).BACKEND_AUTH_TOKEN ?? "";
      const res = await fetch("http://127.0.0.1:3000/api/auth/password", {
        headers: { "x-auth-token": token },
        signal: AbortSignal.timeout(2000),
      });
      const body: unknown = await res.json();
      const configured =
        typeof body === "object" && body !== null && "configured" in body
          ? body.configured === true
          : undefined;
      if (configured !== undefined) {
        checks.push({
          id: "password",
          ok: true,
          detail: configured
            ? "a console-set password exists (it wins over the launcher's)"
            : "no console-set password: the launcher's secret is the one that logs in",
        });
      }
    } catch {
      // The backend answered /health but not this route (older artifact).
    }
  }

  // 13. the binary the backend spawns per Run
  try {
    const entry = resolveOmaBin();
    checks.push({ id: "oma-bin", ok: true, detail: `runs will spawn ${entry}` });
  } catch (err: unknown) {
    checks.push({
      id: "oma-bin",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      fix: "install oma (npm/bun) or run 'bun run build' in the repo",
    });
  }

  return checks;
}
