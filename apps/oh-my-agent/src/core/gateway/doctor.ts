import { existsSync } from "node:fs";
import { join } from "node:path";
import { currentVersion, gatewayPaths, omaHome, omaVersion, readSecrets } from "./artifact.js";
import { isProcessAlive, readDaemon } from "./daemon.js";
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

/** Diagnose why a gateway may not be able to run anything: artifact, tools,
 *  catalog source, runnable providers, ports, and the per-Run oma binary. */
export async function diagnoseGateway(opts: DoctorOptions = {}): Promise<GatewayCheck[]> {
  const home = opts.home ?? omaHome();
  const paths = gatewayPaths(home);
  const checks: GatewayCheck[] = [];

  // 1. artifact
  const version = currentVersion(home) ?? omaVersion();
  const dir = join(paths.versions, version);
  const manifestPath = join(dir, "gateway.json");
  if (existsSync(manifestPath)) {
    const manifest = readGatewayManifest(manifestPath);
    checks.push({
      id: "artifact",
      ok: true,
      detail: `${version} installed (${manifest.components.length} components) at ${dir}`,
    });
  } else {
    checks.push({
      id: "artifact",
      ok: false,
      detail: `no gateway artifact for ${version} at ${dir}`,
      fix: `oma gateway fetch --version ${version}`,
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
          fix: "export a key and restart, e.g. DEEPSEEK_API_KEY=... oma gateway down && oma gateway up -d",
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
      fix: "add a provider key to the environment the gateway runs in (builtin), or put a models.yml where OMA_HOME points (custom)",
    });
  }

  // 6. ports + detached state (informational)
  const listening: string[] = [];
  for (const port of [3000, 3001]) {
    const probe = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })
      .then(() => true)
      .catch(() => false);
    if (probe) listening.push(String(port));
  }
  const daemon = readDaemon(home);
  const detached =
    daemon && isProcessAlive(daemon.pid) ? `detached, pid ${daemon.pid}` : "not detached";
  checks.push({
    id: "running",
    ok: true,
    detail: `${detached}; ports answering: ${listening.length > 0 ? listening.join(", ") : "none"}`,
  });

  // 7. the binary the backend spawns per Run
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

  // secrets sanity: a missing file means the next `up` generates one (fine),
  // but a half-written one would break the web component.
  const secrets = readSecrets(home);
  checks.push({
    id: "secrets",
    ok: true,
    detail:
      Object.keys(secrets).length > 0
        ? `${join(home, "gateway-secrets.json")} holds ${Object.keys(secrets).join(", ")}`
        : `no secrets yet at ${join(home, "gateway-secrets.json")} (generated on first up)`,
  });

  return checks;
}
