import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadProjectSettings } from "../settings/project-settings.js";
import { createFastembedProvider, type EmbeddingProvider } from "./embeddings.js";
import { retainMemory } from "./vector-recall.js";
import { openVectorMemoryStore, type VectorMemoryStore } from "./vector-store.js";

/** Wiring seam between the standalone modes and the vector memory layer.
 *
 *  ONE lazily-initialized (store, provider) pair per workspace root per
 *  process; a failed provider init is cached so a missing model degrades to
 *  the FTS voice permanently for this process instead of retrying the ONNX
 *  load on every recall. The DB lives in the workspace (.oma/memory/
 *  memory.db) next to the file-based memory artifacts; learn/autonomous
 *  writes stay file-first — the DB is an index, never the source of truth. */

export interface VectorMemory {
  readonly store: VectorMemoryStore;
  readonly provider: EmbeddingProvider | null;
}

const instances = new Map<string, VectorMemory | null>();

export function memoryDbPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".oma", "memory", "memory.db");
}

/** Open (or reuse) the workspace's vector memory. Resolves null when the
 *  provider cannot start (no model) — callers keep the store's FTS voice. */
export function getVectorMemory(workspaceRoot: string): VectorMemory | null {
  if (instances.has(workspaceRoot)) return instances.get(workspaceRoot) ?? null;
  let instance: VectorMemory | null;
  try {
    const dbPath = memoryDbPath(workspaceRoot);
    // A fresh workspace has no .oma/memory yet — create it, or the open
    // fails and the whole vector layer silently never mounts.
    mkdirSync(dirname(dbPath), { recursive: true });
    const store = openVectorMemoryStore(dbPath);
    // The workspace setting pins the model; absent = the default. (This is
    // the standalone layer only — never the product RPC path.)
    const model = loadProjectSettings(workspaceRoot).memoryVector?.model;
    const provider = createFastembedProvider(model ? { model } : undefined);
    instance = { store, provider };
  } catch {
    instance = null;
  }
  instances.set(workspaceRoot, instance);
  return instance;
}

/** Standalone modes mount the vector layer unless it is disabled. Order:
 *  explicit workspace setting > OMA_VECTOR_MEMORY env (tests/CI use "0") >
 *  default ON. */
export function vectorMemoryEnabled(workspaceRoot: string): boolean {
  const setting = loadProjectSettings(workspaceRoot).memoryVector?.enabled;
  if (setting !== undefined) return setting;
  if (process.env.OMA_VECTOR_MEMORY === "0") return false;
  return true;
}

/** Test seam: drop the cached instance so a new DB path/model is honored. */
export function resetVectorMemoryForTests(): void {
  instances.clear();
}

/** In-flight backfill guard: the TUI assembles a Runtime per message, so a
 *  cold start would otherwise race two identical backfills (double embed). */
const backfillInFlight = new WeakMap<VectorMemory, Promise<number>>();

/** Reconcile learned.md into the store: retain every lesson the index is
 *  missing, skip the ones it already holds. Incremental rather than one-shot,
 *  because the learn double-write is fire-and-forget — a process that exits
 *  before the async index write lands would otherwise lose that lesson
 *  permanently. The per-lesson existence check runs BEFORE embedding, so a
 *  steady-state pass costs N index lookups and no inference. Best-effort:
 *  embedding failures land FTS-only rows. */
export function backfillLearnedLessons(
  memory: VectorMemory,
  workspaceRoot: string,
): Promise<number> {
  const existing = backfillInFlight.get(memory);
  if (existing) return existing;
  const run = runBackfill(memory, workspaceRoot).finally(() => backfillInFlight.delete(memory));
  backfillInFlight.set(memory, run);
  return run;
}

async function runBackfill(memory: VectorMemory, workspaceRoot: string): Promise<number> {
  const learned = join(workspaceRoot, ".oma", "memory", "learned.md");
  if (!existsSync(learned)) return 0;
  const lines = readFileSync(learned, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  let added = 0;
  for (const line of lines) {
    // Format: - [date] **context** content  |  - [date] content
    const m = /^-\s*\[\d{4}-\d{2}-\d{2}\]\s+(?:\*\*(.+?)\*\*\s+)?(.+)$/.exec(line);
    if (!m) continue;
    const content = m[2]!;
    // Already indexed: skip. This is what keeps a steady-state pass free (no
    // embedding) and keeps `added` honest — retainMemory returns the EXISTING
    // id for a duplicate, so it cannot be used to tell "wrote" from "already
    // there".
    if (memory.store.byContent(content)) continue;
    const id = await retainMemory(memory.store, memory.provider, {
      content,
      ...(m[1] ? { context: m[1] } : {}),
      source: "backfill",
    });
    if (id) added++;
  }
  return added;
}
