import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseCatalogYAML } from "@chengchenccc/ai";

export interface ProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly api: "anthropic-messages" | "openai-completions";
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly defaultModel: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-6",
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "openai",
    label: "OpenAI (GPT / o-series)",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4.1",
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat",
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultModel: "anthropic/claude-sonnet-4",
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible endpoint",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:8000/v1",
    apiKeyEnv: "CUSTOM_API_KEY",
    defaultModel: "default",
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
];

export const SETUP_USAGE = `oma setup - configure a model provider in ~/.oma/models.yml

Usage:
  oma setup    interactive wizard to configure provider, API key, and default model
`;

export function defaultModelsYamlPath(
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.OMA_HOME) return join(env.OMA_HOME, "models.yml");
  return join(env.HOME ?? homedir(), ".oma", "models.yml");
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

/** Upsert a provider block into `~/.oma/models.yml`, preserving any other
 *  providers already configured there. Validates the result via parseCatalogYAML. */
export function writeProviderToModelsYaml(
  filePath: string,
  entry: {
    providerId: string;
    api: "anthropic-messages" | "openai-completions";
    baseUrl: string;
    apiKeyEnv: string;
    apiKey: string;
    modelId: string;
    contextWindow?: number;
    maxTokens?: number;
  },
): void {
  let existingProviders: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      const parsed = parseCatalogYAML(readFileSync(filePath, "utf8"));
      existingProviders = { ...parsed.providers };
    } catch {
      /* overwrite malformed file cleanly */
    }
  }
  const existingProvider = existingProviders[entry.providerId] as
    | { models?: Array<Record<string, unknown>> }
    | undefined;
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const nextModels = [
    ...existingModels.filter((m) => m.id !== entry.modelId),
    {
      id: entry.modelId,
      name: entry.modelId,
      reasoning: true,
      contextWindow: entry.contextWindow ?? 128_000,
      maxTokens: entry.maxTokens ?? 16_384,
    },
  ];
  existingProviders[entry.providerId] = {
    api: entry.api,
    baseUrl: entry.baseUrl.trim().replace(/\/+$/, ""),
    apiKeyEnv: entry.apiKeyEnv,
    apiKey: entry.apiKey,
    models: nextModels,
  };

  // Serialize cleanly as valid YAML (subset parseCatalogYAML reads deterministically).
  const lines: string[] = ["providers:"];
  for (const [pid, rawSpec] of Object.entries(existingProviders)) {
    const spec = rawSpec as {
      api?: string;
      baseUrl?: string;
      apiKeyEnv?: string;
      apiKey?: string;
      models?: Array<{
        id: string;
        name?: string;
        reasoning?: boolean;
        contextWindow?: number;
        maxTokens?: number;
      }>;
    };
    lines.push(`  ${pid}:`);
    if (spec.api) lines.push(`    api: ${yamlQuote(spec.api)}`);
    if (spec.baseUrl) lines.push(`    baseUrl: ${yamlQuote(spec.baseUrl)}`);
    if (spec.apiKeyEnv) lines.push(`    apiKeyEnv: ${yamlQuote(spec.apiKeyEnv)}`);
    if (spec.apiKey) lines.push(`    apiKey: ${yamlQuote(spec.apiKey)}`);
    lines.push("    models:");
    for (const m of spec.models ?? []) {
      lines.push(`      - id: ${yamlQuote(m.id)}`);
      if (m.name) lines.push(`        name: ${yamlQuote(m.name)}`);
      if (typeof m.reasoning === "boolean") lines.push(`        reasoning: ${m.reasoning}`);
      if (typeof m.contextWindow === "number") {
        lines.push(`        contextWindow: ${m.contextWindow}`);
      }
      if (typeof m.maxTokens === "number") lines.push(`        maxTokens: ${m.maxTokens}`);
    }
  }
  const yaml = `${lines.join("\n")}\n`;
  // Self-verify round-trip before writing.
  parseCatalogYAML(yaml);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, yaml, { encoding: "utf8", mode: 0o600 });
}

export async function runSetupWizard(opts?: {
  env?: Record<string, string | undefined>;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): Promise<{ configured: boolean; modelId?: string; filePath?: string }> {
  const input = opts?.input ?? process.stdin;
  const output = opts?.output ?? process.stdout;
  if (!opts?.input && !process.stdin.isTTY) {
    output.write(
      "No available models configured. Set an API key (e.g. ANTHROPIC_API_KEY / OPENAI_API_KEY) or run `oma setup` in an interactive terminal.\n",
    );
    return { configured: false };
  }
  const rl = createInterface({ input, output });
  try {
    output.write("\noma setup — configure a model provider\n\n");
    PROVIDER_PRESETS.forEach((p, idx) => {
      output.write(`  ${idx + 1}) ${p.label} (${p.apiKeyEnv})\n`);
    });
    output.write("\n");
    const choiceRaw = (await rl.question("Choose provider [1]: ")).trim();
    const idx = choiceRaw ? Number.parseInt(choiceRaw, 10) - 1 : 0;
    const preset = PROVIDER_PRESETS[idx] ?? PROVIDER_PRESETS[0]!;

    let providerId = preset.id;
    let api: "anthropic-messages" | "openai-completions" = preset.api;
    let baseUrl = preset.baseUrl;
    if (preset.id === "custom") {
      const customId = (await rl.question("Provider id [custom]: ")).trim();
      if (customId && /^[a-z0-9_-]+$/i.test(customId)) providerId = customId;
      const customApi = (
        await rl.question(
          "API protocol (openai-completions / anthropic-messages) [openai-completions]: ",
        )
      ).trim();
      if (customApi === "anthropic-messages") api = "anthropic-messages";
    }
    const baseUrlInput = (await rl.question(`Base URL [${baseUrl}]: `)).trim();
    if (baseUrlInput) baseUrl = baseUrlInput;

    const modelInput = (await rl.question(`Default model id [${preset.defaultModel}]: `)).trim();
    const modelId = modelInput || preset.defaultModel;

    const apiKey = (await rl.question(`API key (${preset.apiKeyEnv}): `)).trim();
    if (!apiKey) {
      output.write("Setup cancelled (empty API key).\n");
      return { configured: false };
    }

    const filePath = defaultModelsYamlPath(opts?.env);
    writeProviderToModelsYaml(filePath, {
      providerId,
      api,
      baseUrl,
      apiKeyEnv: preset.apiKeyEnv,
      apiKey,
      modelId,
      contextWindow: preset.contextWindow,
      maxTokens: preset.maxTokens,
    });
    const canonical = `${providerId}/${modelId}`;
    output.write(`\nSaved provider "${providerId}" to ${filePath} (model: ${canonical}).\n`);
    return { configured: true, modelId: canonical, filePath };
  } finally {
    rl.close();
  }
}
