/**
 * What a harness declares about itself over ACP.
 *
 * The protocol carries no static catalog: a harness states the models it can
 * run (and the other configuration it accepts) in the `session/new`
 * response's `configOptions`, with `category: "model"` on the model entry.
 * Measured 2026-09-30 through this same client - omp declares 216 models, pi
 * 13, claude 5 (its own aliases: opus/sonnet/haiku), and oma, our own server
 * (ADR 0039 P2), declares none. The values are each harness's own
 * vocabulary, so callers pass them back untouched.
 *
 * Learning this costs a session, so callers cache the result instead of
 * probing on every render.
 */
import * as acp from "@agentclientprotocol/sdk";
import {
  AcpBackendError,
  type AcpSpawn,
  type AcpTransport,
  createNodeSpawn,
} from "./acp-backend.js";
import { ACP_AGENTS } from "./registry.js";

export interface AcpHarnessModel {
  readonly value: string;
  readonly name: string;
}

export interface AcpHarnessCatalog {
  readonly harness: string;
  /** Models the harness offers, in its own vocabulary; empty when it declares none. */
  readonly models: readonly AcpHarnessModel[];
  /** The model it would use when the run does not name one. */
  readonly currentModel: string | null;
  /** Config options that are not the model (mode, effort, agent, ...). */
  readonly otherOptions: readonly { readonly id: string; readonly category: string }[];
}

export interface ProbeHarnessCatalogOptions {
  readonly key: string;
  readonly cwd: string;
  /** Per-registry-key launch override, the AcpBackend convention. */
  readonly commands?: Readonly<Record<string, readonly string[]>>;
  /** Transport factory; tests replace it with an in-memory fake. */
  readonly spawnImpl?: AcpSpawn;
  readonly timeoutMs?: number;
}

interface RawConfigOption {
  readonly id?: unknown;
  readonly category?: unknown;
  readonly currentValue?: unknown;
  readonly options?: ReadonlyArray<{ readonly value?: unknown; readonly name?: unknown }>;
}

/** Read one harness's own declaration by opening, and closing, a single session. */
export async function probeHarnessCatalog(
  opts: ProbeHarnessCatalogOptions,
): Promise<AcpHarnessCatalog> {
  const entry = ACP_AGENTS[opts.key];
  if (!entry) {
    throw new AcpBackendError(
      "not_found",
      `unknown ACP harness '${opts.key}' (known: ${Object.keys(ACP_AGENTS).join(", ")})`,
    );
  }
  const argv = opts.commands?.[opts.key] ?? entry.argv;
  const spawn = opts.spawnImpl ?? createNodeSpawn(0);
  const transport = spawn({ argv: [...argv], cwd: opts.cwd, env: process.env });
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readCatalog(transport, opts.key, opts.cwd),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AcpBackendError(
                "spawn_failed",
                `harness '${opts.key}' did not answer session/new within ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    transport.kill();
  }
}

async function readCatalog(
  transport: AcpTransport,
  key: string,
  cwd: string,
): Promise<AcpHarnessCatalog> {
  let catalog: AcpHarnessCatalog | undefined;
  const client = acp.client({ name: "harness-catalog-probe" });
  await client.connectWith(transport.stream, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const created = (await ctx.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
    } as never)) as { configOptions?: readonly RawConfigOption[] };
    catalog = toCatalog(key, created.configOptions ?? []);
  });
  if (!catalog) {
    throw new AcpBackendError("spawn_failed", `harness '${key}' closed before declaring a session`);
  }
  return catalog;
}

/** Pure: a `session/new` response's config options, split the way callers use them. */
export function toCatalog(key: string, options: readonly RawConfigOption[]): AcpHarnessCatalog {
  const model = options.find((option) => option.category === "model");
  const models: AcpHarnessModel[] = [];
  for (const candidate of model?.options ?? []) {
    if (typeof candidate.value === "string") {
      models.push({
        value: candidate.value,
        name: typeof candidate.name === "string" ? candidate.name : candidate.value,
      });
    }
  }
  const otherOptions: Array<{ id: string; category: string }> = [];
  for (const option of options) {
    if (option === model || typeof option.id !== "string") continue;
    otherOptions.push({
      id: option.id,
      category: typeof option.category === "string" ? option.category : "unknown",
    });
  }
  return {
    harness: key,
    models,
    currentModel: typeof model?.currentValue === "string" ? model.currentValue : null,
    otherOptions,
  };
}
