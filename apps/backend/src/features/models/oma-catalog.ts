import { childEnv } from "@chengchenccc/agent-contract";
import { z } from "zod";

/** How to launch the oma CLI for a catalogue read. Structurally what
 *  resolveOmaCommand produces; declared here so the backend does not depend
 *  on the adapter package's type for it (that package retires with the kind
 *  era, ADR 0040 R3). */
export interface OmaCatalogCommand {
  readonly executable: string;
  readonly args?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
}

/** The wire shape `oma --list-models` prints (one JSON document on stdout).
 *  Field-level copy of the adapter's protocol schema; the type-level single
 *  source stays BackendModelCatalog until agent-contract dissolves (R4). */
const catalogSchema = z.object({
  backendKind: z.string(),
  models: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      reasoning: z.boolean(),
      inputModalities: z.array(z.string()),
      contextWindow: z.number(),
      maxOutputTokens: z.number(),
      available: z.boolean(),
      cost: z.object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number(),
        cacheWrite: z.number(),
      }),
    }),
  ),
});

export type OmaModelCatalogListing = z.infer<typeof catalogSchema>;

/** The process surface this catalogue needs; injectable so the bounds, exit
 *  and cache paths are testable without spawning the CLI. */
export type OmaCatalogSpawn = (cmd: {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}) => {
  stdout: AsyncIterable<Uint8Array>;
  stderrText(): Promise<string>;
  exit: Promise<number | null>;
  kill(): void;
};

const LIST_MODELS_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const bunSpawn: OmaCatalogSpawn = ({ argv, env }) => {
  const child = Bun.spawn({
    cmd: [...argv],
    cwd: process.cwd(),
    env: childEnv(env),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: child.stdout as AsyncIterable<Uint8Array>,
    stderrText: () => new Response(child.stderr).text(),
    exit: child.exited.then((code) => code ?? null),
    kill: () => child.kill(),
  };
};

/** Model catalogue over the oma CLI: spawns `oma --list-models` and parses
 *  the canonical catalogue. The backend never maintains its own provider
 *  registry — the CLI's registration (builtins + custom models.yml) is the
 *  single source, so the listing cannot drift from what runs actually serve.
 *  Successful results are cached per instance until invalidate(). */
export function createOmaModelCatalog(
  command: OmaCatalogCommand,
  spawn: OmaCatalogSpawn = bunSpawn,
) {
  let cached: OmaModelCatalogListing | null = null;

  return {
    /** Drop the cached catalogue so the next list() spawns a fresh child. */
    invalidate(): void {
      cached = null;
    },

    async list(): Promise<OmaModelCatalogListing> {
      if (cached) return cached;
      // --list-models is mode-independent; the run command carries
      // --mode rpc, which is meaningless here - strip the pair.
      const base = command.args ?? [];
      const listArgs = base.filter((a) => a !== "--mode" && a !== "rpc");
      const proc = spawn({
        argv: [command.executable, ...listArgs, "--list-models"],
        env: command.env ?? {},
      });
      const decoder = new TextDecoder();
      let text = "";
      let bytes = 0;
      for await (const chunk of proc.stdout) {
        const part = decoder.decode(chunk, { stream: true });
        bytes += part.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          proc.kill();
          throw new Error("oma --list-models output exceeded the 1 MiB bound");
        }
        text += part;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const code = await Promise.race([
        proc.exit,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), LIST_MODELS_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer);
      if (code !== 0) {
        if (code === null) proc.kill();
        const tail = (await proc.stderrText()).slice(-2000);
        throw new Error(`oma --list-models exited with code ${code}: ${tail}`);
      }
      try {
        cached = catalogSchema.parse(JSON.parse(text));
        return cached;
      } catch (err) {
        throw new Error(
          `malformed --list-models output: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },
  };
}
