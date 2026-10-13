/**
 * Conversation summarizer: folds a slice of transcript into one short summary
 * that the product context projection can carry in place of the covered entries
 * (`ProductSummaryEntry`, agent-context/projection.ts).
 *
 * This is the backend's only model call. It stays absent unless
 * `BACKEND_SUMMARY_MODEL` is configured — /compact then answers 501 rather than
 * pretending, which is the honest default for a deployment with no credential.
 */
import {
  BUILTIN_CATALOG,
  buildAllModels,
  createModelRuntime,
  createProvider,
  type ModelRuntime,
} from "@chengchenccc/ai";
import type { AIMessageChunk, Message } from "@chengchenccc/message";

export type SummarizerCredentials = (providerId: string) => {
  apiKey?: string;
  baseUrl?: string;
};

export interface SummarizerDeps {
  runtime: ModelRuntime;
  credentialFor: SummarizerCredentials;
  /** `<provider>/<model>` as the catalogue knows it (e.g. `deepseek/…`). */
  providerId: string;
  modelId: string;
}

/** Keep summaries bounded: the projection has a token budget, and an over-long
 *  summary defeats the point of replacing entries with one. */
const MAX_SUMMARY_CHARS = 1200;
/** Turns below this are still sent (short messages matter), but empties are not. */
const MIN_TEXT_CHARS = 1;

const SYSTEM_PROMPT =
  "You compress a software-engineering conversation for future context. " +
  "Write plain prose in the conversation's own language (usually Chinese). " +
  "Keep: decisions with their why, current state, open threads, exact names " +
  "(files, commands, ids). Drop: greetings, restated plans, tool noise. " +
  `No preamble, no headings, at most ${MAX_SUMMARY_CHARS} characters.`;

/** A ModelRuntime over the builtin catalogue. Keys are resolved per call (see
 *  `createSummarizer`), so adding one later needs no restart — and registration
 *  is not filtered by key, so a missing credential surfaces as a provider error
 *  on a configured model instead of a silent "provider not found". */
export function createSummaryRuntime(): ModelRuntime {
  const runtime = createModelRuntime();
  const built = buildAllModels(BUILTIN_CATALOG);
  for (const [providerId, entry] of Object.entries(built)) {
    runtime.registerProvider(
      createProvider({
        id: providerId,
        name: providerId,
        baseUrl: entry.spec.baseUrl,
        auth: {},
        models: entry.models,
      }),
    );
  }
  return runtime;
}

/** The text a summarizer will see: whitespace-only turns add nothing. */
export function summarizerInput(texts: readonly string[]): string {
  return texts
    .map((t) => t.trim())
    .filter((t) => t.length >= MIN_TEXT_CHARS)
    .join("\n\n");
}

export function createSummarizer(
  deps: SummarizerDeps,
): (texts: readonly string[]) => Promise<string> {
  return async (texts) => {
    const input = summarizerInput(texts);
    if (input.length === 0) return "";
    const messages: Message[] = [
      { role: "user", text: `${SYSTEM_PROMPT}\n\n--- transcript ---\n${input}` },
    ];
    const credential = deps.credentialFor(deps.providerId);
    let out = "";
    const stream = deps.runtime.stream(deps.providerId, deps.modelId, messages, {
      ...(credential.apiKey ? { apiKey: credential.apiKey } : {}),
      ...(credential.baseUrl ? { baseUrl: credential.baseUrl } : {}),
    }) as AsyncIterable<AIMessageChunk>;
    for await (const chunk of stream) {
      if (chunk.delta?.type === "text" && chunk.delta.text) out += chunk.delta.text;
    }
    return out.trim().slice(0, MAX_SUMMARY_CHARS);
  };
}

/** The production entry point: `<provider>/<model>` from BACKEND_SUMMARY_MODEL,
 *  or undefined when the operator has not configured one (compaction then keeps
 *  answering 501). A malformed value fails the boot rather than silently
 *  disabling compaction. */
export function createConfiguredSummarizer(
  spec: string | undefined,
  credentialFor: SummarizerCredentials,
): ((input: { texts: readonly string[] }) => Promise<string>) | undefined {
  if (!spec) return undefined;
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`BACKEND_SUMMARY_MODEL must be "<provider>/<model>", got: ${spec}`);
  }
  const summarizer = createSummarizer({
    runtime: createSummaryRuntime(),
    credentialFor,
    providerId: spec.slice(0, slash),
    modelId: spec.slice(slash + 1),
  });
  return (input) => summarizer(input.texts);
}
