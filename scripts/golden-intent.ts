// Golden intent replay: does a REAL model produce the facets this product
// expects? Deterministic tests guard the tables; this guards the prompt and
// the model's ability to fill a structured contract at all.
//
//   DEEPSEEK_API_KEY=... bun run scripts/golden-intent.ts [--model deepseek-chat]
//
// Not part of CI: it costs model calls and depends on a provider being up.
// Every case prints its expected vs actual line; exit 1 when any differs.

import { GOLDEN_INTENT_CASES } from "../apps/backend/src/features/product-tools/golden-intent.cases.js";
import { createModelRuntime, createProvider } from "../packages/ai/src/index.js";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("DEEPSEEK_API_KEY is required (this script is opt-in, not a CI gate)");
  process.exit(2);
}

const args = process.argv.slice(2);
const modelArg = args.indexOf("--model");
const modelId = modelArg >= 0 ? (args[modelArg + 1] ?? "deepseek-chat") : "deepseek-chat";

const model = {
  id: modelId,
  name: modelId,
  provider: "deepseek",
  api: "openai-completions" as const,
  reasoning: false,
  input: ["text"] as const,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64_000,
  maxTokens: 2048,
  compat: { thinkingFormat: "deepseek" as const, maxTokensField: "max_tokens" as const },
};

const rt = createModelRuntime();
rt.registerProvider(
  createProvider({
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    auth: { apiKey },
    models: [model],
  }),
);

const SYSTEM = [
  "You are the front desk of a small agent team. Decide what a human request is.",
  "",
  "Actions:",
  '- "answer": you can satisfy it yourself in a reply; it changes nothing.',
  '- "ask": it is work, but some required detail is missing.',
  '- "dispatch": it is work and every required detail is present.',
  "",
  "Verbs and their required slots (a brief missing any slot must be action=ask):",
  "fix: repro, expected, scope, acceptance",
  "build: goal, scope, acceptance, constraints",
  "review: target, criteria",
  "investigate: question, sources, stop",
  "write: audience, form, source",
  "operate: environment, action, rollback",
  "",
  "Deliverables: answer, change, report, state-change.",
  "Never invent a slot value that the request does not state or clearly imply.",
  "",
  "ALWAYS fill verb — including when action is ask. On ask, verb is the kind of",
  "work waiting for details, and missingSlots lists EXACTLY the slot names from",
  "that verb's list that the request does not supply. An empty missingSlots with",
  "action=ask is wrong: ask means something is missing.",
].join("\n");

const schema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["answer", "ask", "dispatch"] },
    verb: {
      type: "string",
      enum: ["fix", "build", "review", "investigate", "write", "operate", "answer"],
    },
    deliverable: {
      type: "string",
      enum: ["answer", "change", "report", "state-change"],
    },
    missingSlots: { type: "array", items: { type: "string" } },
  },
  required: ["action", "verb", "deliverable", "missingSlots"],
  additionalProperties: false,
};

interface Verdict {
  action: string;
  verb: string;
  deliverable: string;
  missingSlots: string[];
}

async function classify(message: string): Promise<Verdict> {
  let text = "";
  for await (const chunk of rt.stream(
    "deepseek",
    model.id,
    [
      { role: "system", text: SYSTEM },
      { role: "user", text: message },
    ],
    { apiKey, responseFormat: { name: "intent", schema, strict: true } },
  )) {
    if (chunk.delta?.type === "text" && chunk.delta.text) text += chunk.delta.text;
  }
  const parsed = JSON.parse(text) as Partial<Verdict>;
  // A "strict" schema is a request, not a guarantee: normalize before judging.
  return {
    action: typeof parsed.action === "string" ? parsed.action : "(none)",
    verb: typeof parsed.verb === "string" ? parsed.verb : "(none)",
    deliverable: typeof parsed.deliverable === "string" ? parsed.deliverable : "(none)",
    missingSlots: Array.isArray(parsed.missingSlots)
      ? parsed.missingSlots.filter((x): x is string => typeof x === "string")
      : [],
  };
}

let failures = 0;
for (const c of GOLDEN_INTENT_CASES) {
  const expected = c.expected;
  // Cases this single-verdict replay cannot express are skipped, not fudged:
  // - multi: one utterance, two briefs (the tool schema is one dispatch per call)
  // - recall-dependent cases: the replay has no memory to resolve "那个"
  if (
    expected.action === "multi" ||
    c.id === "ask-ellipsis" ||
    c.id === "answer-remembered-question"
  ) {
    console.log(`skip ${c.id}: needs multi-brief or recall context (deterministic corpus only)`);
    continue;
  }
  const want =
    expected.action === "answer"
      ? { action: "answer", verb: "-", missing: [] as string[] }
      : {
          action: expected.action,
          verb: expected.verb,
          missing: "missing" in expected ? [...expected.missing] : [],
        };

  let got: Verdict | null = null;
  try {
    got = await classify(c.message);
  } catch (err) {
    console.log(`FAIL ${c.id}: model call failed — ${(err as Error).message}`);
    failures += 1;
    continue;
  }

  // A model cannot decompose into two briefs through this single-verdict
  // schema; for that case only the action family is checked.
  const actionOk = got.action === want.action;
  const verbOk = want.verb === "-" ? true : got.verb === want.verb;
  const missingOk =
    want.missing.length === 0
      ? got.missingSlots.length === 0
      : [...got.missingSlots].sort().join(",") === [...want.missing].sort().join(",");
  const ok = actionOk && verbOk && missingOk;
  if (!ok) failures += 1;

  console.log(
    `${ok ? "ok  " : "FAIL"} ${c.id}: want=${want.action}/${want.verb}/${want.missing || "none"} got=${got.action}/${got.verb}/${got.missingSlots.join(",") || "none"}`,
  );
}

const total = GOLDEN_INTENT_CASES.filter(
  (c) =>
    c.expected.action !== "multi" &&
    c.id !== "ask-ellipsis" &&
    c.id !== "answer-remembered-question",
).length;
console.log(`\n${total - failures}/${total} matched`);
process.exit(failures === 0 ? 0 : 1);
