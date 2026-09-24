import { z } from "zod";

/** Agent portable config — the parsed form of workspace `agent.yml`
 *  (ADR 0020 decision 1: agent.yml is the single source; the DB holds
 *  only the FK anchor + this materialized cache). */

export const agentConfigSchema = z.object({
  schema_version: z.literal("1"),
  enabled: z.boolean(),
  id: z.string().min(1),
  name: z.string().min(1),
  title: z.string(),
  description: z.string(),
  runtime_config: z.object({
    /** BackendKind: oma | claude_code | pi | omp. */
    runtime: z.string().min(1),
    model_id: z.string().min(1),
    reasoning_effort: z.union([z.enum(["none", "low", "high", "max"]), z.literal("")]),
    permission_mode: z.enum(["ask", "auto", "deny"]),
    max_steps: z.number().int().nonnegative(),
    /** Per-agent resource switches (ADR 0022, file-first). */
    mcp_servers: z
      .array(z.object({ server_id: z.string().min(1), enabled: z.boolean() }))
      .default([]),
    knowledge_packs: z.array(z.string()).default([]),
    /** Attached projects (ADR 0023): each materializes a worktree. */
    projects: z.array(z.string().min(1)).default([]),
  }),
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
          }),
        )
        .default({}),
      /** Require a real @mention in groups (openclaw's `requireMention`,
       *  default true). */
      require_mention: z.boolean().default(true),
      /** Whether an `@everyone` counts as addressing the bot. Off by
       *  default: an @all is not a request to this agent. */
      respond_to_mention_all: z.boolean().default(false),
      /** Marks which semantics the stored allowlist was written under.
       *  Revision 1 meant "empty list = everyone"; revision 2 (current)
       *  means "empty list = nobody". The transform below upgrades rev-1
       *  configs so an existing install keeps answering, instead of going
       *  silent on upgrade. */
      policy_rev: z.number().int().default(2),
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

/** Build the canonical config from the API input shape. Missing fields
 *  fall back to `prev` (update) or defaults (create). */
export function buildAgentConfig(input: {
  id: string;
  name?: string;
  model?: { provider: string; model: string };
  backendKind?: string;
  enabled?: boolean;
  reasoningEffort?: string | null;
  permissionMode?: "ask" | "auto" | "deny";
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
  };
  prev?: AgentConfig;
}): AgentConfig {
  const prev = input.prev;
  const runtime = input.backendKind ?? prev?.runtime_config.runtime ?? "oma";
  const modelId = input.model
    ? `${input.model.provider}/${input.model.model}`
    : (prev?.runtime_config.model_id ?? "unconfigured/none");
  return agentConfigSchema.parse({
    schema_version: "1",
    enabled: input.enabled ?? prev?.enabled ?? true,
    id: input.id,
    name: input.name ?? prev?.name ?? input.id,
    title: input.name ?? prev?.title ?? prev?.name ?? input.id,
    description: prev?.description ?? "",
    runtime_config: {
      runtime,
      model_id: modelId,
      reasoning_effort:
        input.reasoningEffort !== undefined
          ? (input.reasoningEffort ?? "")
          : (prev?.runtime_config.reasoning_effort ?? ""),
      permission_mode: input.permissionMode ?? prev?.runtime_config.permission_mode ?? "ask",
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
      policy_rev: 2,
      profile_ref: prev?.lark.profile_ref ?? (input.lark?.enabled ? `agent:${input.id}` : ""),
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
    `  runtime: ${q(rc.runtime)}`,
    `  model_id: ${q(rc.model_id)}`,
    `  reasoning_effort: ${q(rc.reasoning_effort)}`,
    `  permission_mode: ${q(rc.permission_mode)}`,
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
    "",
  ].join("\n");
}
