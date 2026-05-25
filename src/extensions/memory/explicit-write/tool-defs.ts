// Tool definitions for memory.remember and memory.forget.
// Pure data — no IO, no side effects.

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const rememberToolDef: ToolDefinition = {
  name: 'memory.remember',
  description: `Persist a piece of durable knowledge so future conversations can recall it.
Use this when the user explicitly asks to remember something, or when you (the assistant)
identify a stable preference / fact / decision that should outlive this conversation.

Do NOT use for:
- One-off conversation context (use scratchpad)
- Sensitive credentials / secrets
- Information the user explicitly marked as ephemeral`,
  parameters: {
    type: 'object',
    required: ['text', 'type'],
    properties: {
      text: {
        type: 'string',
        description: 'Self-contained statement (one sentence). Avoid pronouns; mention the subject explicitly.',
        maxLength: 500,
      },
      type: {
        type: 'string',
        enum: ['preference', 'fact', 'decision', 'instruction'],
        description: 'Category. preference=stable user taste, fact=immutable knowledge, decision=past choice, instruction=behavioral rule',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional topic tags for grouping (e.g. ["ui", "appearance"])',
        maxItems: 8,
      },
      weight: {
        type: 'number',
        description: 'Initial importance 0.1–1.0. Default 0.6 for explicit remembers.',
        minimum: 0.1,
        maximum: 1.0,
      },
    },
  },
};

export const forgetToolDef: ToolDefinition = {
  name: 'memory.forget',
  description: `Mark a previously stored memory as no longer valid.
Use this when the user explicitly revokes or contradicts past instructions/preferences.
By default this is a soft delete (the entry stays but is hidden from retrieval).
Pass hard=true only if the user explicitly says "delete permanently".`,
  parameters: {
    type: 'object',
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description: 'Natural-language description of what to forget. Will be matched against stored entries via semantic search.',
      },
      type: {
        type: 'string',
        enum: ['preference', 'fact', 'decision', 'instruction'],
        description: 'Optional type filter to narrow the match.',
      },
      hard: {
        type: 'boolean',
        description: 'If true, physically delete. Default false (soft delete via supersede).',
        default: false,
      },
      confirm: {
        type: 'boolean',
        description: 'Must be true to actually delete. If false/omitted, returns matches for user confirmation.',
        default: false,
      },
    },
  },
};
