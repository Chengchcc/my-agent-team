import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type GatewayManifest, readGatewayManifest } from "./manifest.js";

export class GatewayArtifactError extends Error {}

const DEFAULT_STACK_REPO = "Chengchcc/my-agent-team";

/** Written last, after a version is fully unpacked: its presence is what makes
 *  an install idempotent. */
const INSTALL_MARKER = ".complete";

export function omaHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMA_HOME ?? join(homedir(), ".oma");
}

/** The launcher's on-disk layout, in one place: code lives under
 *  gateway/versions/<version>/, state under gateway-data/ so an upgrade that swaps
 *  code keeps databases, workspaces and workflows. */
export interface GatewayPaths {
  home: string;
  root: string;
  versions: string;
  /** Text file naming the active version. */
  current: string;
  data: string;
  secrets: string;
}

export function gatewayPaths(home: string = omaHome()): GatewayPaths {
  const root = join(home, "gateway");
  return {
    home,
    root,
    versions: join(root, "versions"),
    current: join(root, "current"),
    data: join(home, "gateway-data"),
    secrets: join(home, "gateway-secrets.json"),
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
  throw new GatewayArtifactError(`no version found in ${pkgPath}`);
}

export interface ReleaseLocation {
  tarball: string;
  sums: string;
}

/** Where a version's artifact lives. GitHub releases by default; a mirror (or a
 *  local test server) via OMA_GATEWAY_BASE_URL, which must serve the same paths. */
export function releaseLocation(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): ReleaseLocation {
  const repo = env.OMA_GATEWAY_REPO ?? DEFAULT_STACK_REPO;
  const base = (
    env.OMA_GATEWAY_BASE_URL ?? `https://github.com/${repo}/releases/download/v${version}`
  ).replace(/\/+$/, "");
  return { tarball: `${base}/oma-gateway-${version}.tar.zst`, sums: `${base}/SHA256SUMS` };
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
  throw new GatewayArtifactError(`SHA256SUMS has no entry for ${fileName}`);
}

/** How long a download may go without delivering a byte before it is called
 *  dead. A slow-but-moving transfer is fine; a wedged one must not hang an
 *  install (a postinstall sat for 10 minutes before this existed). */
const DEFAULT_STALL_MS = 60_000;

async function withStallTimeout<T>(work: Promise<T>, ms: number, onStall: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onStall()), ms);
  });
  try {
    return await Promise.race([work, stall]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function download(url: string, dest: string, stallMs: number): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (err: unknown) {
    throw new GatewayArtifactError(
      `cannot reach ${url}: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (!res.ok) throw new GatewayArtifactError(`${url} -> HTTP ${res.status}`);
  if (!res.body) throw new GatewayArtifactError(`${url} returned no body`);
  // NOT `Bun.write(dest, res)`: on Bun 1.3.14 that hangs forever on a ~13MB
  // body (fetch returns 200 in 8ms, the write never lands). Streaming by hand
  // also keeps a 60MB artifact out of memory.
  const writer = Bun.file(dest).writer();
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await withStallTimeout(
        reader.read(),
        stallMs,
        () =>
          new GatewayArtifactError(
            `download stalled for ${Math.round(stallMs / 1000)}s at ${url} — check the connection, then retry`,
          ),
      );
      if (done) break;
      writer.write(value);
    }
  } catch (err: unknown) {
    await reader.cancel().catch(() => {});
    throw err;
  }
  await writer.end();
}

async function unpack(tarball: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  if (!Bun.which("tar")) throw new GatewayArtifactError("tar not found on PATH");
  if (!Bun.which("zstd")) {
    throw new GatewayArtifactError("zstd not found on PATH — the gateway artifact is a .tar.zst");
  }
  const proc = Bun.spawn(["tar", "--zstd", "-xf", tarball, "-C", dest], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new GatewayArtifactError(`tar failed (exit ${code}): ${stderr.trim()}`);
  }
}

/** Read the launcher's secrets without generating anything (status paths). */
/** Human-typed login password. Entropy comes from length, not from requiring
 *  character classes: 22 chars over a 56-symbol alphabet is ~128 bits. The
 *  alphabet drops look-alikes (l, 1, I, O, 0) and shell-hostile punctuation,
 *  because the person typing it may be reading it off a terminal on another
 *  device. */
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const PASSWORD_LENGTH = 22;

export function generatePassword(): string {
  // Rejection sampling keeps the alphabet uniform (256 % 56 is not zero).
  const ceiling = Math.floor(256 / PASSWORD_ALPHABET.length) * PASSWORD_ALPHABET.length;
  let password = "";
  while (password.length < PASSWORD_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(PASSWORD_LENGTH))) {
      if (byte >= ceiling) continue;
      password += PASSWORD_ALPHABET.charAt(byte % PASSWORD_ALPHABET.length);
      if (password.length === PASSWORD_LENGTH) break;
    }
  }
  return password;
}

/** Internal tokens (backend auth, session signing): never typed, so the cheap
 *  hex encoding is fine. */
function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function readSecrets(home: string): Record<string, string> {
  const path = gatewayPaths(home).secrets;
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new GatewayArtifactError(`${path} is not valid JSON — fix or delete it`);
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
 *  authenticate the local single-user gateway. */
export async function ensureSecrets(
  home: string,
  names: readonly string[],
): Promise<Record<string, string>> {
  const existing = readSecrets(home);
  let generated = false;
  for (const name of names) {
    if (existing[name]) continue;
    // MOCK_PASSWORD is the one a human retypes at the login page; the rest are
    // machine-to-machine tokens.
    existing[name] = name === "MOCK_PASSWORD" ? generatePassword() : generateToken();
    generated = true;
  }
  if (generated) {
    const path = gatewayPaths(home).secrets;
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
  /** No-byte allowance before a download is declared dead (test seam). */
  stallMs?: number;
}

export interface FetchResult {
  version: string;
  dir: string;
  downloaded: boolean;
  manifest: GatewayManifest;
  sha256?: string;
}

/** Download, verify and unpack one gateway version. Idempotent: a version that is
 *  already unpacked is reused (delete its directory to force a re-fetch). */
export async function fetchGatewayArtifact(opts: FetchOptions = {}): Promise<FetchResult> {
  const env = opts.env ?? process.env;
  const paths = gatewayPaths(opts.home ?? omaHome(env));
  const version = opts.version ?? omaVersion();
  const log = opts.log ?? (() => {});
  const dir = join(paths.versions, version);
  const manifestPath = join(dir, "gateway.json");

  if (existsSync(join(dir, INSTALL_MARKER)) && existsSync(manifestPath)) {
    log(`gateway ${version} already installed at ${dir}`);
    return { version, dir, downloaded: false, manifest: readGatewayManifest(manifestPath) };
  }

  const { tarball: tarballUrl, sums: sumsUrl } = releaseLocation(version, env);
  const tmp = join(paths.versions, `.tmp-${version}-${process.pid}`);
  const tarball = join(tmp, `oma-gateway-${version}.tar.zst`);
  const unpacked = join(tmp, "unpacked");
  await mkdir(tmp, { recursive: true });

  try {
    log(`downloading ${tarballUrl}`);
    const sums = await fetch(sumsUrl, { redirect: "follow" });
    if (!sums.ok) throw new GatewayArtifactError(`${sumsUrl} -> HTTP ${sums.status}`);
    const expected = parseSums(await sums.text(), `oma-gateway-${version}.tar.zst`);

    await download(tarballUrl, tarball, opts.stallMs ?? DEFAULT_STALL_MS);
    const actual = await sha256File(tarball);
    if (actual !== expected) {
      throw new GatewayArtifactError(
        `checksum mismatch for ${version}: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`,
      );
    }
    log(`verified sha256 ${actual.slice(0, 12)}…`);

    await unpack(tarball, unpacked);
    const manifest = readGatewayManifest(join(unpacked, "gateway.json"));

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
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.current, `${version}\n`);
    log(`installed ${version} at ${dir}`);
    return { version, dir, downloaded: true, manifest, sha256: actual };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export function installedVersions(home: string = omaHome()): string[] {
  const dir = gatewayPaths(home).versions;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .sort();
}

export function currentVersion(home: string = omaHome()): string | undefined {
  try {
    const value = readFileSync(gatewayPaths(home).current, "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
