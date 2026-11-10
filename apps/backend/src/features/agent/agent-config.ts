import { z } from "zod";

/** Agent portable config — the parsed form of workspace `agent.yml`
 *  (ADR 0020 decision 1: agent.yml is the single source; the DB holds
 *  only the FK anchor + this materialized cache). */

/** Harness used when nothing else says otherwise (create without one, or no
 *  previous config to inherit). Keys are ACP_AGENTS keys. */
export const DEFAULT_HARNESS = "oma";

/** Stored when an agent names no model: the harness then runs its own default. */
export const UNCONFIGURED_MODEL = "";

/** Keys the config carried before the harness+model rename (18fa47fb):
 *  `runtime` held a BackendKind, `model_id` the provider/model pair, and
 *  `harness_model` the ACP-side model for the ACP kinds. */
const LEGACY_BACKEND_KIND: Record<string, string> = { claude_code: "claude" };
/** The old spelling of "no model chosen yet"; the current shape uses "". */
const LEGACY_UNCONFIGURED_MODEL = "unconfigured/none";

/** ADR 0046 ambient rule: what an OBSERVED (unaddressed) group message may
 *  be promoted into. `record` only logs the would-do; `act` also frames the
 *  message as a task and triggers the agent. Substring match on purpose —
 *  a mistyped regex silently matches nothing (or everything). */
const ambientRuleSchema = z
  .object({
    id: z.string().min(1),
    /** Scope: chats this rule fires in (Lark chat ids). Empty = every chat
     *  the bot already observes (admitted + unaddressed). */
    chats: z.array(z.string().min(1)).default([]),
    /** Scope: senders this rule fires for (open_id, same vocabulary as
     *  allowed_senders). Empty = any admitted sender. */
    senders: z.array(z.string().min(1)).default([]),
    /** Case-insensitive substring the message text must contain. */
    keyword: z.string().min(1),
    mode: z.enum(["record", "act"]),
    /** The task framing the agent gets. Required for `act` — an act rule
     *  without an instruction fires a run that doesn't know its job. */
    instruction: z.string().default(""),
  })
  .superRefine((rule, ctx) => {
    if (rule.mode === "act" && rule.instruction.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["instruction"],
        message: "an act rule requires an instruction",
      });
    }
  });
/** Upgrade a runtime_config written before the rename.
 *
 *  The rename changed the axes with no data migration, and boot lists agents
 *  early (its name map) — so a single row written before it made the whole
 *  backend fail to start with an opaque ZodError on `runtime_config.harness`.
 *
 *  The model mapping follows what the two old fields MEANT: `harness_model` was
 *  the value the harness itself ran (today's `model`, which agentModelRef still
 *  hands to the child as `harnessModel`), while `model_id` was the product-side
 *  provider/model pair that the new shape replaced with a constant. So
 *  harness_model wins when it is set; model_id is the fallback for the rows
 *  that never had one (an oma-era row carried its model there).
 *
 *  Unknown shapes are passed through untouched: the parse then fails loudly on
 *  the field it cannot read, which is the point. */
function upgradeLegacyRuntimeConfig(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const rc = value as Record<string, unknown>;
  if (typeof rc.harness === "string") return value; // already current
  const runtime = typeof rc.runtime === "string" ? rc.runtime : undefined;
  if (runtime === undefined) return value;
  const { runtime: _runtime, model_id, harness_model, ...rest } = rc;
  const modelId = typeof model_id === "string" ? model_id : "";
  const harnessModel = typeof harness_model === "string" ? harness_model : "";
  // The old placeholder meant "nothing chosen"; the new shape spells that "".
  const fallbackModel = modelId === LEGACY_UNCONFIGURED_MODEL ? "" : modelId;
  return {
    ...rest,
    harness: LEGACY_BACKEND_KIND[runtime] ?? runtime,
    model: harnessModel !== "" ? harnessModel : fallbackModel,
  };
}

export const agentConfigSchema = z.object({
  schema_version: z.literal("1"),
  enabled: z.boolean(),
  id: z.string().min(1),
  name: z.string().min(1),
  title: z.string(),
  description: z.string(),
  runtime_config: z.preprocess(
    upgradeLegacyRuntimeConfig,
    z.object({
      /** Which harness runs this agent: a key of the ACP registry
       *  (oma | omp | claude | pi). The adapter is no longer named here - one
       *  adapter drives every harness (ADR 0040 decision 7). */
      harness: z.string().min(1),
      /** The model that harness runs, in the harness's own vocabulary.
       *  "" = the harness's own default. */
      model: z.string().default(""),
      reasoning_effort: z.union([z.enum(["none", "low", "high", "max"]), z.literal("")]),
      permission_mode: z.enum(["ask", "auto", "deny", "yolo"]),
      deny_write_paths: z.array(z.string()).default([]),
      deny_commands: z.array(z.string()).default([]),
      allow_write_paths: z.array(z.string()).default([]),
      max_steps: z.number().int().nonnegative(),
      /** Per-agent resource switches (ADR 0022, file-first). */
      mcp_servers: z
        .array(z.object({ server_id: z.string().min(1), enabled: z.boolean() }))
        .default([]),
      knowledge_packs: z.array(z.string()).default([]),
      /** Attached projects (ADR 0023): each materializes a worktree. */
      projects: z.array(z.string().min(1)).default([]),
    }),
  ),
  lark: z
    .object({
      enabled: z.boolean(),
      app_id: z.string(),
      bot_display_name: z.string(),
      /** DM sender allowlist (open_id). Semantics follow openclaw's model:
       *  an EMPTY list denies everyone and `"*"` grants everyone — the
       *  permissive case is named instead of implied by emptiness, because
       *  "nobody" and "everybody" used to look identical here. */
      allowed_senders: z.array(z.string().min(1)).default([]),
      /** Group admission default, for chats with no `groups` entry:
       *  `open` = every group, `allowlist` = the allowlist below,
       *  `disabled` = only chats already in use (see the lark-bot policy).
       *  Absent = `disabled`. */
      group_policy: z.enum(["open", "allowlist", "disabled"]).optional(),
      /** Per-chat overrides, keyed by Lark chat id (`oc_…`). An entry is
       *  also what admits a chat: a group with no entry and no existing
       *  conversation is not answered. */
      groups: z
        .record(
          z.string().min(1),
          z.object({
            policy: z.enum(["open", "allowlist", "disabled"]).optional(),
            allowed_senders: z.array(z.string().min(1)).optional(),
            /** Per-chat mention requirement. Absent = the agent's setting,
             *  then the policy default (an `open` chat does not need an @). */
            require_mention: z.boolean().optional(),
          }),
        )
        .default({}),
      /** Require a real @mention in groups (openclaw's `requireMention`,
       *  default true). */
      require_mention: z.boolean().default(true),
      /** Whether an `@everyone` counts as addressing the bot. Off by
       *  default: an @all is not a request to this agent. */
      respond_to_mention_all: z.boolean().default(false),
      /** ADR 0046: ambient rules promote OBSERVED (unaddressed) group
       *  messages into work. Evaluated by the backend at the observe seam
       *  (conversation postMessage), never by the bot. */
      ambient: z.object({ rules: z.array(ambientRuleSchema).default([]) }).default({ rules: [] }),
      /** Marks which semantics the stored allowlist was written under.
       *  Revision 1 meant "empty list = everyone"; revision 2 (current)
       *  means "empty list = nobody". The transform below upgrades rev-1
       *  configs so an existing install keeps answering, instead of going
       *  silent on upgrade. */
      // Absent means "written before this semantics existed" — NOT rev 2.
      // Defaulting to 2 here silently disabled the migration for every real
      // legacy config (they have no such key), which would have read an
      // empty list as "deny everyone" and locked the operator out.
      policy_rev: z.number().int().default(1),
      /** Server-generated (Lark profile init); backend writes it back. */
      profile_ref: z.string(),
    })
    .transform((lk) => {
      if (lk.policy_rev >= 2) return lk;
      return {
        ...lk,
        // Rev 1 wrote `[]` for "no restriction"; carry that intent forward
        // as the explicit wildcard rather than as an empty (now denying) list.
        allowed_senders: lk.allowed_senders.length === 0 ? ["*"] : lk.allowed_senders,
        policy_rev: 2,
      };
    }),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

/** ADR 0046: one ambient rule, parsed form (see `lark.ambient.rules`). */
export type AmbientRule = AgentConfig["lark"]["ambient"]["rules"][number];

/** Build the canonical config from the API input shape. Missing fields
 *  fall back to `prev` (update) or defaults (create). */
export function buildAgentConfig(input: {
  id: string;
  name?: string;
  /** Which harness runs this agent (an ACP_AGENTS key). */
  harness?: string;
  /** The model that harness runs, in its own vocabulary. "" = its default. */
  model?: string;
  enabled?: boolean;
  reasoningEffort?: string | null;
  permissionMode?: "ask" | "auto" | "deny" | "yolo";
  /** Write-path policy: a boundary, so it is enforced even in yolo. */
  denyWritePaths?: string[];
  allowWritePaths?: string[];
  denyCommands?: string[];
  maxSteps?: number;
  mcpServers?: Array<{ serverId: string; enabled: boolean }>;
  knowledgePacks?: string[];
  projects?: string[];
  lark?: {
    enabled?: boolean;
    appId?: string;
    botDisplayName?: string;
    /** DM sender allowlist (open_id); `"*"` is the explicit wildcard. */
    allowedSenders?: string[];
    /** Default policy for groups with no entry in `groups`. */
    groupPolicy?: "open" | "allowlist" | "disabled";
    /** Per-chat overrides keyed by Lark chat id. */
    groups?: Record<
      string,
      { policy?: "open" | "allowlist" | "disabled"; allowedSenders?: string[] }
    >;
    requireMention?: boolean;
    respondToMentionAll?: boolean;
    /** ADR 0046 ambient rules (observe seam promotion). Replace-semantics,
     *  like `groups`: the array given IS the new rule list. */
    ambientRules?: Array<{
      id: string;
      chats?: string[];
      senders?: string[];
      keyword: string;
      mode: "record" | "act";
      instruction?: string;
    }>;
  };
  prev?: AgentConfig;
}): AgentConfig {
  const prev = input.prev;
  const harness = input.harness ?? prev?.runtime_config.harness ?? DEFAULT_HARNESS;
  const model = input.model ?? prev?.runtime_config.model ?? UNCONFIGURED_MODEL;
  return agentConfigSchema.parse({
    schema_version: "1",
    enabled: input.enabled ?? prev?.enabled ?? true,
    id: input.id,
    name: input.name ?? prev?.name ?? input.id,
    title: input.name ?? prev?.title ?? prev?.name ?? input.id,
    description: prev?.description ?? "",
    runtime_config: {
      harness,
      model,
      reasoning_effort:
        input.reasoningEffort !== undefined
          ? (input.reasoningEffort ?? "")
          : (prev?.runtime_config.reasoning_effort ?? ""),
      permission_mode: input.permissionMode ?? prev?.runtime_config.permission_mode ?? "ask",
      deny_write_paths: input.denyWritePaths ?? prev?.runtime_config.deny_write_paths ?? [],
      deny_commands: input.denyCommands ?? prev?.runtime_config.deny_commands ?? [],
      allow_write_paths: input.allowWritePaths ?? prev?.runtime_config.allow_write_paths ?? [],
      max_steps: input.maxSteps ?? prev?.runtime_config.max_steps ?? 0,
      mcp_servers:
        input.mcpServers?.map((s) => ({ server_id: s.serverId, enabled: s.enabled })) ??
        prev?.runtime_config.mcp_servers ??
        [],
      knowledge_packs: input.knowledgePacks ?? prev?.runtime_config.knowledge_packs ?? [],
      projects: input.projects ?? prev?.runtime_config.projects ?? [],
    },
    lark: {
      enabled: input.lark?.enabled ?? prev?.lark.enabled ?? false,
      app_id: input.lark?.appId ?? prev?.lark.app_id ?? "",
      bot_display_name: input.lark?.botDisplayName ?? prev?.lark.bot_display_name ?? "",
      allowed_senders: input.lark?.allowedSenders ?? prev?.lark.allowed_senders ?? ["*"],
      group_policy: input.lark?.groupPolicy ?? prev?.lark.group_policy,
      groups:
        input.lark?.groups !== undefined
          ? Object.fromEntries(
              Object.entries(input.lark.groups).map(([chatId, g]) => [
                chatId,
                {
                  policy: g.policy,
                  allowed_senders: g.allowedSenders,
                },
              ]),
            )
          : (prev?.lark.groups ?? {}),
      require_mention: input.lark?.requireMention ?? prev?.lark.require_mention ?? true,
      respond_to_mention_all:
        input.lark?.respondToMentionAll ?? prev?.lark.respond_to_mention_all ?? false,
      ambient: {
        rules:
          input.lark?.ambientRules !== undefined
            ? input.lark.ambientRules.map((r) => ({
                id: r.id,
                chats: r.chats ?? [],
                senders: r.senders ?? [],
                keyword: r.keyword,
                mode: r.mode,
                instruction: r.instruction ?? "",
              }))
            : (prev?.lark.ambient.rules ?? []),
      },
      policy_rev: 2,
      // `||`, not `??: a seeded agent carries profile_ref "" and enabling
      // lark must derive `agent:<id>` — `??` treats "" as a real value and
      // the agent could never get a profile from PATCH/wizard alone.
      profile_ref: prev?.lark.profile_ref || (input.lark?.enabled ? `agent:${input.id}` : ""),
    },
  });
}

/** Serialize the config to the workspace `agent.yml` format (fixed shape,
 *  JSON-string-quoted values — valid YAML). The backend is the only writer
 *  today; manual edits are picked up by a future file-watch (ADR 0020). */
export function serializeAgentYaml(config: AgentConfig): string {
  const rc = config.runtime_config;
  const lk = config.lark;
  const q = JSON.stringify;
  return [
    "# agent.yml — agent 便携配置的唯一真源(DB 只存锚点 + 缓存)",
    'schema_version: "1"',
    `enabled: ${config.enabled}`,
    `id: ${q(config.id)}`,
    `name: ${q(config.name)}`,
    `title: ${q(config.title)}`,
    `description: ${q(config.description)}`,
    "runtime_config:",
    `  harness: ${q(rc.harness)}`,
    `  model: ${q(rc.model)}`,
    `  reasoning_effort: ${q(rc.reasoning_effort)}`,
    `  permission_mode: ${q(rc.permission_mode)}`,
    "  deny_commands:",
    ...rc.deny_commands.map((c) => `    - ${q(c)}`),
    "  deny_write_paths:",
    ...rc.deny_write_paths.map((p) => `    - ${q(p)}`),
    "  allow_write_paths:",
    ...rc.allow_write_paths.map((p) => `    - ${q(p)}`),
    `  max_steps: ${rc.max_steps}`,
    "  mcp_servers:",
    ...rc.mcp_servers.map((s) => `    - server_id: ${q(s.server_id)}\n      enabled: ${s.enabled}`),
    "  knowledge_packs:",
    ...rc.knowledge_packs.map((p) => `    - ${q(p)}`),
    "  projects:",
    ...rc.projects.map((p) => `    - ${q(p)}`),
    "lark:",
    `  enabled: ${lk.enabled}`,
    `  app_id: ${q(lk.app_id)}`,
    `  bot_display_name: ${q(lk.bot_display_name)}`,
    `  profile_ref: ${q(lk.profile_ref)}`,
    "  allowed_senders:",
    ...lk.allowed_senders.map((s) => `    - ${q(s)}`),
    `  group_policy: ${q(lk.group_policy ?? "disabled")}`,
    `  require_mention: ${lk.require_mention}`,
    `  respond_to_mention_all: ${lk.respond_to_mention_all}`,
    `  policy_rev: ${lk.policy_rev}`,
    "  groups:",
    ...Object.entries(lk.groups).flatMap(([chatId, g]) => [
      `    ${q(chatId)}:`,
      ...(g.policy ? [`      policy: ${q(g.policy)}`] : []),
      ...(g.allowed_senders
        ? ["      allowed_senders:", ...g.allowed_senders.map((s) => `        - ${q(s)}`)]
        : []),
    ]),
    "  ambient:",
    "    rules:",
    ...lk.ambient.rules.flatMap((r) => [
      `      - id: ${q(r.id)}`,
      `        keyword: ${q(r.keyword)}`,
      `        mode: ${q(r.mode)}`,
      `        instruction: ${q(r.instruction)}`,
      ...(r.chats.length > 0
        ? ["        chats:", ...r.chats.map((c) => `          - ${q(c)}`)]
        : []),
      ...(r.senders.length > 0
        ? ["        senders:", ...r.senders.map((s) => `          - ${q(s)}`)]
        : []),
    ]),
    "",
  ].join("\n");
}
