import crypto from 'crypto';
import type { Provider, AgentContext } from '../types';
import type { MemoryEntry, MemoryExtractor, TraceExtractionContext } from './types';
import { DEFAULT_SUMMARY_MODEL } from '../config/constants';

const DEFAULT_WEIGHT = 0.8;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_DAY = MS_PER_SECOND * SECONDS_PER_MINUTE * MINUTES_PER_HOUR * HOURS_PER_DAY;

export class LlmExtractor implements MemoryExtractor {
  constructor(
    private provider: Provider,
    private extractionModel: string = DEFAULT_SUMMARY_MODEL,
  ) {}

  async extract(
    traceContext: TraceExtractionContext,
  ): Promise<MemoryEntry[]> {
    const contextText = this.formatTraceContext(traceContext);
    const prompt = this.buildExtractionPrompt(contextText);
    const response = await this.invokeLlm(prompt);
    return this.parseExtractedResponse(response);
  }

  async consolidate(entries: MemoryEntry[]): Promise<MemoryEntry[]> {
    const prompt = this.buildConsolidationPrompt(entries);
    const response = await this.invokeLlm(prompt);
    return this.parseConsolidatedResponse(response);
  }

  private formatTraceContext(ctx: TraceExtractionContext): string {
    const lines: string[] = [];

    lines.push(`Session overview: ${ctx.totalTurns} turns, ${ctx.toolCalls.length} tool calls, ${ctx.totalErrors} errors.`);

    if (ctx.outcomes.length > 0) {
      lines.push('Key outcomes:');
      for (const o of ctx.outcomes) {
        lines.push(`- ${o}`);
      }
    }

    if (ctx.activatedSkills && ctx.activatedSkills.length > 0) {
      lines.push(`Skills used: ${ctx.activatedSkills.join(', ')}`);
    }

    lines.push('\nUser messages:');
    for (const ut of ctx.userTurns) {
      lines.push(`- ${ut.content}`);
    }

    if (ctx.toolCalls.length > 0) {
      lines.push('\nTool call summary:');
      for (const tc of ctx.toolCalls) {
        const status = tc.success ? 'OK' : `FAILED: ${tc.error ?? 'unknown'}`;
        lines.push(`- ${tc.tool} → ${status}`);
      }
    }

    return lines.join('\n');
  }

  private buildExtractionPrompt(contextText: string): string {
    return `Analyze this agent session trace and extract memory entries for a persistent agent memory system.

Extract exactly these types of information:
1. User preferences or habits (e.g. "prefers pnpm over npm")
2. Project facts (e.g. "uses TypeScript with Bun")
3. Key decisions made (e.g. "decided to store memory in SQLite")
4. Important outcomes (e.g. "fixed markdown rendering bug")

Rules:
- ONLY extract genuinely useful, reusable information
- Skip transient, one-time things like "user asked a question about X"
- Each entry should be a single, clear statement
- NEVER extract API keys, passwords, tokens, or credentials
- Assign weight 0-1: 0.9+ for strong preferences/important facts, 0.6-0.8 for general knowledge, <0.6 for tentative
- Return a JSON array: [{"text": string, "tags": string[] | undefined, "weight": number (0-1)}]
- If nothing worth remembering, return an empty array []

Session trace:
${contextText}`;
  }

  private buildConsolidationPrompt(entries: MemoryEntry[]): string {
    const now = Date.now();
    const entryLines = entries.map((e, i) => {
      const ageDays = Math.round((now - new Date(e.created).getTime()) / MS_PER_DAY);
      const lastHitDays = e.lastHitAt
        ? Math.round((now - e.lastHitAt) / MS_PER_DAY)
        : '(never)';
      return `[${i + 1}] id=${e.id} weight=${e.weight} used=${e.usageCount ?? 0} times lastHit=${lastHitDays}d ago age=${ageDays}d | ${e.text}`;
    });

    return `Consolidate these memory entries. Use the usage stats to decide:

When to keep:
- usageCount >= 3 or lastHitAt within 7 days → actively used, preserve
- weight >= 0.9 → strong user preference, preserve
- project facts → preserve unless explicitly contradicted

When to remove:
- usageCount = 0 and age > 30 days → likely stale
- usageCount < 3 and lastHitAt > 30 days → low value, consider removing
- exact duplicate of another entry → merge keeping the newer

Rules:
1. Merge duplicates — keep the more specific, recent version
2. Conflicting entries — keep the newer one with higher usageCount
3. Combine related entries into clearer, more concise statements
4. Preserve original id, created, source, projectPath if unchanged
5. Return: [{"text": string, "tags": string[], "weight": number (0-1), "id"?, "created"?, "source"?, "projectPath"?}]

Entries:
${entryLines.join('\n')}`;
  }

  private async invokeLlm(prompt: string): Promise<string> {
    // Create a minimal context for the provider invoke
    const context: AgentContext = {
      messages: [{ role: 'user' as const, content: prompt }],
      config: { tokenLimit: 100000, model: this.extractionModel },
      metadata: {},
    };

    // We need to set the model - the provider should already be configured
    // Use the extraction model specified in constructor
    // Note: This assumes the provider is already initialized with the correct API key
    const response = await this.provider.invoke(context);
    return response.content;
  }

  private parseExtractedResponse(content: string): MemoryEntry[] {
    try {
      // Find JSON array in the response (handle extra text)
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        id?: string;
        type?: MemoryEntry['type'];
        text?: string;
        tags?: string[];
        created?: string;
        weight?: number;
        source?: MemoryEntry['source'];
        projectPath?: string;
        metadata?: Record<string, unknown>;
        files?: string[];
      }>;

      const now = new Date().toISOString();
      return parsed
        .filter(p => p.text)
        .map(p => {
          const entry: MemoryEntry = {
            id: p.id ?? crypto.randomUUID(),
            type: 'general' as const,
            text: p.text!,
            created: p.created ?? now,
            weight: p.weight ?? DEFAULT_WEIGHT,
            source: p.source ?? ('implicit' as const),
          };
          if (p.tags?.length) entry.tags = p.tags;
          if (p.metadata) entry.metadata = p.metadata;
          if (p.files?.length) entry.files = p.files;
          return entry;
        })
        .filter(p => p.text.trim().length > 0);
    } catch {
      return [];
    }
  }

  private parseConsolidatedResponse(content: string): MemoryEntry[] {
    try {
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        id?: string;
        type?: MemoryEntry['type'];
        text?: string;
        tags?: string[];
        weight?: number;
        created?: string;
        source?: MemoryEntry['source'];
        projectPath?: string;
        metadata?: Record<string, unknown>;
        files?: string[];
      }>;

      const now = new Date().toISOString();
      return parsed
        .filter(p => p.text)
        .map(p => {
          const entry: MemoryEntry = {
            id: p.id ?? crypto.randomUUID(),
            type: 'general' as const,
            text: p.text!,
            created: p.created ?? now,
            weight: p.weight ?? DEFAULT_WEIGHT,
            source: p.source ?? ('implicit' as const),
          };
          if (p.tags?.length) entry.tags = p.tags;
          if (p.metadata) entry.metadata = p.metadata;
          if (p.files?.length) entry.files = p.files;
          return entry;
        })
        .filter(p => p.text.trim().length > 0);
    } catch {
      return [];
    }
  }
}

