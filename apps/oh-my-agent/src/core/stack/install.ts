import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readStackManifest, type StackManifest } from "./manifest.js";

export class StackInstallError extends Error {}

export const DEFAULT_STACK_REPO = "Chengchcc/my-agent-team";

/** Written last, after a version is fully unpacked: its presence is what makes
 *  an install idempotent. */
const INSTALL_MARKER = ".complete";

export function omaHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMA_HOME ?? join(homedir(), ".oma");
}

/** The launcher's on-disk layout, in one place: code lives under
 *  stack/versions/<version>/, state under stack-data/ so an upgrade that swaps
 *  code keeps databases, workspaces and workflows. */
export interface StackPaths {
  home: string;
  stack: string;
  versions: string;
  /** Text file naming the active version. */
  current: string;
  data: string;
  secrets: string;
}

export function stackPaths(home: string = omaHome()): StackPaths {
  const stack = join(home, "stack");
  return {
    home,
    stack,
    versions: join(stack, "versions"),
    current: join(stack, "current"),
    data: join(home, "stack-data"),
    secrets: join(home, "stack-secrets.json"),
  };
}

/** oma's own version, from the package this build belongs to (src/ and dist/
 *  are both three levels below the package root). */
export function omaVersion(): string {
  const pkgPath = resolve(import.meta.dirname, "../../../package.json");
  const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
    const version: unknown = parsed.version;
    if (typeof version === "string") return version;
  }
  throw new StackInstallError(`no version found in ${pkgPath}`);
}

export interface ReleaseLocation {
  tarball: string;
  sums: string;
}

/** Where a version's artifact lives. GitHub releases by default; a mirror (or a
 *  local test server) via OMA_STACK_BASE_URL, which must serve the same paths. */
export function releaseLocation(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): ReleaseLocation {
  const repo = env.OMA_STACK_REPO ?? DEFAULT_STACK_REPO;
  const base = (
    env.OMA_STACK_BASE_URL ?? `https://github.com/${repo}/releases/download/v${version}`
  ).replace(/\/+$/, "");
  return { tarball: `${base}/oma-stack-${version}.tar.zst`, sums: `${base}/SHA256SUMS` };
}

export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).bytes());
  return hasher.digest("hex");
}

/** Parse the SHA256SUMS entry for one file (GNU coreutils format). */
export function parseSums(sums: string, fileName: string): string {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (match && match[2] === fileName) return (match[1] ?? "").toLowerCase();
  }
  throw new StackInstallError(`SHA256SUMS has no entry for ${fileName}`);
}

async function download(url: string, dest: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (err: unknown) {
    throw new StackInstallError(`cannot reach ${url}: ${err instanceof Error ? err.message : err}`);
  }
  if (!res.ok) throw new StackInstallError(`${url} -> HTTP ${res.status}`);
  if (!res.body) throw new StackInstallError(`${url} returned no body`);
  // NOT `Bun.write(dest, res)`: on Bun 1.3.14 that hangs forever on a ~13MB
  // body (fetch returns 200 in 8ms, the write never lands). Streaming by hand
  // also keeps a 60MB artifact out of memory.
  const writer = Bun.file(dest).writer();
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    writer.write(value);
  }
  await writer.end();
}

async function unpack(tarball: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  if (!Bun.which("tar")) throw new StackInstallError("tar not found on PATH");
  if (!Bun.which("zstd")) {
    throw new StackInstallError("zstd not found on PATH — the stack artifact is a .tar.zst");
  }
  const proc = Bun.spawn(["tar", "--zstd", "-xf", tarball, "-C", dest], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new StackInstallError(`tar failed (exit ${code}): ${stderr.trim()}`);
  }
}

/** Read the launcher's secrets without generating anything (status paths). */
export function readSecrets(home: string): Record<string, string> {
  const path = stackPaths(home).secrets;
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new StackInstallError(`${path} is not valid JSON — fix or delete it`);
  }
  const secrets: Record<string, string> = {};
  if (typeof parsed === "object" && parsed !== null) {
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") secrets[key] = value;
    }
  }
  return secrets;
}

/** Read the launcher's secrets, generating any missing one. 0600: they
 *  authenticate the local single-user stack. */
export async function ensureSecrets(
  home: string,
  names: readonly string[],
): Promise<Record<string, string>> {
  const existing = readSecrets(home);
  let generated = false;
  for (const name of names) {
    if (existing[name]) continue;
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    existing[name] = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    generated = true;
  }
  if (generated) {
    const path = stackPaths(home).secrets;
    await mkdir(home, { recursive: true });
    await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  }
  return existing;
}

export interface FetchOptions {
  home?: string;
  version?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface FetchResult {
  version: string;
  dir: string;
  downloaded: boolean;
  manifest: StackManifest;
  sha256?: string;
}

/** Download, verify and unpack one stack version. Idempotent: a version that is
 *  already unpacked is reused (delete its directory to force a re-fetch). */
export async function fetchStack(opts: FetchOptions = {}): Promise<FetchResult> {
  const env = opts.env ?? process.env;
  const paths = stackPaths(opts.home ?? omaHome(env));
  const version = opts.version ?? omaVersion();
  const log = opts.log ?? (() => {});
  const dir = join(paths.versions, version);
  const manifestPath = join(dir, "stack.json");

  if (existsSync(join(dir, INSTALL_MARKER)) && existsSync(manifestPath)) {
    log(`stack ${version} already installed at ${dir}`);
    return { version, dir, downloaded: false, manifest: readStackManifest(manifestPath) };
  }

  const { tarball: tarballUrl, sums: sumsUrl } = releaseLocation(version, env);
  const tmp = join(paths.versions, `.tmp-${version}-${process.pid}`);
  const tarball = join(tmp, `oma-stack-${version}.tar.zst`);
  const unpacked = join(tmp, "unpacked");
  await mkdir(tmp, { recursive: true });

  try {
    log(`downloading ${tarballUrl}`);
    const sums = await fetch(sumsUrl, { redirect: "follow" });
    if (!sums.ok) throw new StackInstallError(`${sumsUrl} -> HTTP ${sums.status}`);
    const expected = parseSums(await sums.text(), `oma-stack-${version}.tar.zst`);

    await download(tarballUrl, tarball);
    const actual = await sha256File(tarball);
    if (actual !== expected) {
      throw new StackInstallError(
        `checksum mismatch for ${version}: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`,
      );
    }
    log(`verified sha256 ${actual.slice(0, 12)}…`);

    await unpack(tarball, unpacked);
    const manifest = readStackManifest(join(unpacked, "stack.json"));

    await rm(dir, { recursive: true, force: true });
    await mkdir(paths.versions, { recursive: true });
    await rename(unpacked, dir);
    await writeFile(
      join(dir, INSTALL_MARKER),
      `${JSON.stringify(
        { version, sha256: actual, source: tarballUrl, fetchedAt: new Date().toISOString() },
        null,
        2,
      )}\n`,
    );
    await mkdir(paths.stack, { recursive: true });
    await writeFile(paths.current, `${version}\n`);
    log(`installed ${version} at ${dir}`);
    return { version, dir, downloaded: true, manifest, sha256: actual };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export function installedVersions(home: string = omaHome()): string[] {
  const dir = stackPaths(home).versions;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .sort();
}

export function currentVersion(home: string = omaHome()): string | undefined {
  try {
    const value = readFileSync(stackPaths(home).current, "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
