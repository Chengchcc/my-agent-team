import { accessSync, constants, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { currentVersion, ensureSecrets, omaHome, omaVersion, stackPaths } from "./install.js";
import {
  componentDir,
  readStackManifest,
  resolveComponentEnv,
  type StackComponent,
  type StackManifest,
  startupOrder,
} from "./manifest.js";

export class StackStartError extends Error {}

type Piped = Bun.Subprocess<"ignore", "pipe", "pipe">;

/** The oma executable the backend spawns per Run. Prefer the entry we were
 *  launched from (that is what an npm install gives), fall back to the built
 *  CLI of this package so a source checkout works after `bun run build`. */
export function resolveOmaBin(): string {
  const candidates = [process.argv[1], resolve(import.meta.dirname, "../../../dist/cli.js")].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  for (const candidate of candidates) {
    // Only a JS entry counts: under `bun test` argv[1] is the bun binary, and
    // handing that to the backend as OMA_BIN would spawn `bun --mode rpc` per Run.
    if (!/\.(js|mjs|ts)$/.test(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not executable — try the next candidate
    }
  }
  throw new StackStartError(
    `no executable oma entry found (tried ${candidates.join(", ")}) — install oma, or run 'bun run build' first`,
  );
}

/** Secret names the launcher must generate: the ones a component declares plus
 *  every {secret:NAME} its env mentions. */
function requiredSecrets(manifest: StackManifest): string[] {
  const names = new Set<string>();
  for (const component of manifest.components) {
    for (const name of component.secrets) names.add(name);
    for (const value of Object.values(component.env)) {
      for (const match of value.matchAll(/\{secret:([^}]+)\}/g)) {
        if (match[1]) names.add(match[1]);
      }
    }
  }
  return [...names].sort();
}

export interface UpOptions {
  home?: string;
  /** Version to run; defaults to the recorded current version, then oma's own. */
  version?: string;
  /** Artifact directory, bypassing the version lookup (tests, dev). */
  dir?: string;
  bunPath?: string;
  log?: (line: string) => void;
  healthTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Stops the stack (tests); production wiring uses process signals. */
  signal?: AbortSignal;
  /** Called once every component is up, before waiting (the CLI prints URLs). */
  onReady?: (handle: StackHandle) => void;
}

export interface StackHandle {
  manifest: StackManifest;
  dir: string;
  secrets: Record<string, string>;
  /** Idempotent: SIGTERM everyone in reverse start order, then SIGKILL. */
  stop(): Promise<void>;
  /** Exit code: the first component that died on its own, else 0 after stop(). */
  done: Promise<number>;
}

/** Start every component in the manifest, gate on health, stream prefixed logs
 *  and keep the whole tree in step. */
export async function startStack(opts: UpOptions = {}): Promise<StackHandle> {
  const home = opts.home ?? omaHome();
  const paths = stackPaths(home);
  const log = opts.log ?? (() => {});
  let version = opts.version ?? process.env.OMA_STACK_VERSION;
  if (!version) version = currentVersion(home);
  if (!version) version = omaVersion();
  const dir = opts.dir ?? join(paths.versions, version);
  const manifestPath = join(dir, "stack.json");
  if (!existsSync(manifestPath)) {
    throw new StackStartError(
      `no stack at ${dir} — run 'oma --stack-fetch' first (or 'oma --stack-status')`,
    );
  }
  const manifest = readStackManifest(manifestPath);

  const secrets = await ensureSecrets(home, requiredSecrets(manifest));
  const omaBin = resolveOmaBin();
  const bunPath = opts.bunPath ?? process.execPath;

  const order = startupOrder(manifest);
  const running: { component: StackComponent; proc: Piped }[] = [];
  const prefix = (name: string, line: string): void => log(`[${name}] ${line}`);

  async function pump(name: string, stream: ReadableStream<Uint8Array> | undefined): Promise<void> {
    if (!stream) return;
    const decoder = new TextDecoder();
    let rest = "";
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value, { stream: true });
      let index = rest.indexOf("\n");
      while (index >= 0) {
        prefix(name, rest.slice(0, index));
        rest = rest.slice(index + 1);
        index = rest.indexOf("\n");
      }
    }
    if (rest.length > 0) prefix(name, rest);
  }

  let stopRequested = false;
  let settle: (code: number) => void = () => {};
  const done = new Promise<number>((res) => {
    settle = res;
  });

  async function stop(exitCode = 0): Promise<void> {
    if (stopRequested) return;
    stopRequested = true;
    for (const { component, proc } of [...running].reverse()) {
      log(`stopping ${component.name}`);
      try {
        proc.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    const deadline = Date.now() + 5000;
    for (const { proc } of running) {
      const remaining = Math.max(0, deadline - Date.now());
      await Promise.race([
        proc.exited,
        new Promise((res) => {
          setTimeout(res, remaining);
        }),
      ]);
    }
    for (const { component, proc } of running) {
      if (proc.exitCode === null) {
        log(`${component.name} did not stop on SIGTERM — killing`);
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    // Whether the stack was stopped explicitly or a child died, done must
    // settle — that is the only thing a caller can wait on.
    settle(exitCode);
  }

  try {
    for (const component of order) {
      const cwd = componentDir(component, dir);
      const env = resolveComponentEnv(component, {
        root: dir,
        dataDir: paths.data,
        omaBin,
        secrets,
      });
      const cmd = [bunPath, component.entry];
      if (component.runtime === "node") cmd[0] = "node";
      log(`starting ${component.name}: ${cmd.join(" ")} (cwd ${cwd})`);
      const proc: Piped = Bun.spawn(cmd, {
        cwd,
        env: { ...process.env, ...env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      running.push({ component, proc });
      void pump(component.name, proc.stdout);
      void pump(component.name, proc.stderr);
      void proc.exited.then((code) => {
        if (!stopRequested) {
          log(`${component.name} exited with ${code} — shutting the stack down`);
          void stop(code);
        }
      });

      if (component.healthUrl) {
        const url = component.healthUrl;
        const timeoutMs = opts.healthTimeoutMs ?? 60_000;
        const interval = opts.pollIntervalMs ?? 300;
        const deadline = Date.now() + timeoutMs;
        let healthy = false;
        while (Date.now() < deadline) {
          try {
            const res = await fetch(url);
            if (res.ok) {
              healthy = true;
              break;
            }
          } catch {
            // not listening yet
          }
          await new Promise((res) => {
            setTimeout(res, interval);
          });
        }
        if (!healthy) {
          throw new StackStartError(`${component.name} never became healthy at ${url}`);
        }
        log(`${component.name} healthy at ${url}`);
      }
    }
  } catch (err: unknown) {
    await stop();
    throw err;
  }

  const onAbort = (): void => {
    void stop();
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  return { manifest, dir, secrets, stop, done };
}

/** Run until a signal or a component dies. Returns the exit code. This is the
 *  only entry point that owns process signals: a stack started without them
 *  would be orphaned on Ctrl-C. */
export async function upStack(opts: UpOptions = {}): Promise<number> {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const handle = await startStack({ ...opts, signal: controller.signal });
    opts.onReady?.(handle);
    return await handle.done;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
