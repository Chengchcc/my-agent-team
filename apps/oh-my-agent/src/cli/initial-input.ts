import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ModelRuntime } from "@chengchenccc/ai";
import type { Message, ReasoningEffort } from "@chengchenccc/message";
import { managedSkillsDir } from "../core/memory/managed-skills.js";
import { enabledPluginSkillRoots } from "../core/plugins/plugin-marketplace.js";
import type { BackendRunInput } from "../core/runtime/contract/index.js";
import { buildSystemPrompt, readMemorySummary } from "../core/runtime/prompts.js";
import { agentDir } from "../core/session/session-file.js";
import { loadProjectSettings } from "../core/settings/project-settings.js";
import { readWorkspaceSystemPrompt } from "../core/settings/workspace-context.js";
import { UsageError } from "./args.js";

/** Standalone skill roots (the Product passes its own via the run snapshot):
 *  `<workspace>/.oma/skills` first, then the user-global `<agentDir>/skills`.
 *  `skills` in `.oma/settings.json` overrides the defaults (absolute paths,
 *  or relative to the workspace root). The `enableClaude` / `enableCodex` /
 *  `enableAgents` toggles add Claude / Codex / agent skill dirs to the
 *  defaults. Only existing directories are returned. */
export function resolveStandaloneSkillRoots(workspaceRoot: string): string[] {
  const settings = loadProjectSettings(workspaceRoot);
  const configured = settings.skills;
  const candidates: string[] = [];
  if (configured && configured.length > 0) {
    for (const p of configured) {
      candidates.push(isAbsolute(p) ? p : join(workspaceRoot, p));
    }
  } else {
    const home = process.env.HOME || homedir();
    candidates.push(join(workspaceRoot, ".oma", "skills"));
    candidates.push(join(agentDir(), "skills"));
    if (settings.enableClaude) {
      candidates.push(join(workspaceRoot, ".claude", "skills"), join(home, ".claude", "skills"));
    }
    if (settings.enableCodex) {
      candidates.push(join(workspaceRoot, ".codex", "skills"), join(home, ".codex", "skills"));
    }
    if (settings.enableAgents) {
      candidates.push(
        join(workspaceRoot, ".agent", "skills"),
        join(workspaceRoot, ".agents", "skills"),
        join(home, ".agent", "skills"),
        join(home, ".agents", "skills"),
      );
    }
  }
  const roots: string[] = [];
  for (const dir of candidates) {
    if (existsSync(dir) && statSync(dir).isDirectory()) roots.push(dir);
  }
  for (const dir of enabledPluginSkillRoots(workspaceRoot)) {
    if (!roots.includes(dir)) roots.push(dir);
  }
  // Managed skills (learn-tool minted) resolve DEAD-LAST: any authored skill
  // of the same name shadows them (omp managed-skills semantics).
  const managed = managedSkillsDir();
  if (!roots.includes(managed)) {
    try {
      if (statSync(managed).isDirectory()) roots.push(managed);
    } catch {
      /* absent managed dir */
    }
  }
  return roots;
}

/** One-shot CLI stdin bound: a hostile `cat huge-file | oma -p`
 *  must not balloon memory. */
const MAX_STDIN_BYTES = 16 * 1024 * 1024;

/** Read piped stdin for print/json one-shot runs. Returns undefined when
 *  stdin is a TTY or carries only whitespace. RPC mode NEVER calls this: its
 *  stdin is the JSONL command stream. */
export async function readPipedStdin(
  stream?: ReadableStream<Uint8Array>,
): Promise<string | undefined> {
  if (!stream && process.stdin.isTTY) return undefined;
  const reader = (stream ?? Bun.stdin.stream()).getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_STDIN_BYTES) {
        throw new UsageError("piped stdin exceeds 16 MiB");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  const trimmed = text.trim();
  return trimmed || undefined;
}

/** Merge the CLI prompt with piped stdin: stdin comes FIRST, then a blank
 *  line, then the instruction (the classic `git diff | cli -p "review"`
 *  shape). Whitespace-only parts are dropped. */
export function mergeInitialInput(input: { prompt?: string; piped?: string }): string {
  const parts = [input.piped?.trim(), input.prompt?.trim()].filter((part): part is string =>
    Boolean(part),
  );
  return parts.join("\n\n");
}

/** User message with optional vision images: blocks form when images ride
 *  along (the providers map user image blocks natively); plain text otherwise. */
function buildUserMessage(
  prompt: string,
  images?: ReadonlyArray<{
    mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    base64: string;
  }>,
): Message {
  if (!images || images.length === 0) return { role: "user", text: prompt };
  return {
    role: "user",
    text: prompt,
    blocks: [
      { type: "text", text: prompt },
      ...images.map((img) => ({
        type: "image" as const,
        mediaType: img.mediaType,
        base64: img.base64,
      })),
    ],
  };
}

/** Build the BackendRunInput for a one-shot CLI run: current cwd as the
 *  workspace, empty Product history, the requested model (canonical
 *  `<provider>/<model>` id) or the first available model, no Product Tools,
 *  no system prompt. */

/** Parse `--output-schema <file|json>` into a plain JSON Schema object. */
export function resolveOutputSchemaArg(
  raw: string,
  workspaceRoot: string,
): Readonly<Record<string, unknown>> {
  const trimmed = raw.trim();
  let jsonText = trimmed;
  if (!trimmed.startsWith("{")) {
    const filePath = isAbsolute(trimmed) ? trimmed : resolve(workspaceRoot, trimmed);
    if (!existsSync(filePath)) {
      throw new UsageError(`--output-schema file not found: ${trimmed}`);
    }
    jsonText = readFileSync(filePath, "utf8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new UsageError(
      `--output-schema is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError("--output-schema must be a JSON object");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export async function buildCliRunInput(opts: {
  prompt: string;
  workspaceRoot: string;
  modelRuntime: ModelRuntime;
  /** Canonical `<provider>/<model>` id; undefined = first available. */
  modelId?: string;
  /** Optional reasoning/thinking effort ("none" | "low" | "high" | "max"). */
  reasoningEffort?: ReasoningEffort;
  /** Optional JSON Schema contract appended for headless structured output. */
  outputSchema?: Readonly<Record<string, unknown>>;
  /** Standalone permission gate. undefined = ungated (legacy default);
   *  "yolo" = ungated + OS bash sandbox forced when available. */
  permissionMode?: "ask" | "auto" | "deny" | "yolo";
  /** --read-only: advertise no write/edit/bash/eval to the model. */
  readOnly?: boolean;
  /** Clipboard/pasted images riding this prompt (vision input). */
  images?: ReadonlyArray<{
    mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    base64: string;
  }>;
}): Promise<BackendRunInput> {
  const catalog = await opts.modelRuntime.getCatalog();
  const model = opts.modelId
    ? catalog.models.find((m) => `${m.providerId}/${m.modelId}` === opts.modelId)
    : catalog.models.find((m) => m.available !== false);
  if (opts.modelId && !model) {
    throw new Error(`model not found in catalog: ${opts.modelId}`);
  }
  if (opts.modelId && model && model.available === false) {
    throw new Error(`model unavailable: ${opts.modelId}`);
  }
  if (!model) {
    throw new Error(
      "no available model in the catalog (run `oma setup` or check provider credentials)",
    );
  }
  const modelId = `${model.providerId}/${model.modelId}`;
  const runId = `cli-${randomUUID()}`;
  const skillRoots = resolveStandaloneSkillRoots(opts.workspaceRoot);
  let systemPrompt = buildSystemPrompt({
    workspacePrompt: readWorkspaceSystemPrompt(opts.workspaceRoot),
    memorySummary: readMemorySummary(opts.workspaceRoot),
    cwd: opts.workspaceRoot,
    includeLocalMemory: !opts.readOnly,
  });
  if (opts.outputSchema) {
    systemPrompt =
      `${systemPrompt}\n\n# Required Output Schema\n` +
      "Your final assistant message MUST be a single valid JSON document (no markdown fences, no surrounding prose) conforming to this JSON Schema:\n" +
      `${JSON.stringify(opts.outputSchema)}`;
  }
  const input: BackendRunInput = {
    input: {
      inputId: `cli-in-${randomUUID()}`,
      message: buildUserMessage(opts.prompt, opts.images),
    },
    run: {
      runId,
      model: {
        modelId,
        ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      },
      systemPrompt,
      configRevision: 0,
    },
    workspace: { root: opts.workspaceRoot, access: opts.readOnly ? "read_only" : "read_write" },
    // Standalone agent: no product conversation/agent/branch identity.
  };
  const run = {
    ...input.run,
    ...(skillRoots.length > 0 ? { skillRoots } : {}),
    ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
  };
  return { ...input, run };
}
