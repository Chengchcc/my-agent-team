# WebFetchTool Design Spec

## Overview

Add a `web_fetch` tool that fetches a URL and returns cleaned, structured content suitable for LLM context. The tool is already referenced in `default-prompts.ts` but was not yet implemented.

## Extraction Strategy

Readability-style: strip nav, sidebar, footer, ads, CSS. Return title + main content as clean markdown or text.

Two-tier fetch path:

| Priority | Path | Trigger |
|----------|------|---------|
| 1 | Tavily Extract API | API key configured in settings |
| 2 | Local headless browser | Tavily unavailable or fails → dynamic import Puppeteer |

## Schema

```
url: z.string().url()                                 // URL to fetch
mode: z.enum(['markdown','text']).default('markdown') // output format
maxChars: z.number().int().min(1000).max(200000).default(50000) // truncation
```

## Output

```typescript
interface WebFetchOutput {
  url: string;
  title: string | null;
  content: string;
  format: 'markdown' | 'text';
  truncated: boolean;
  extractedVia: 'tavily' | 'headless';
}
```

## Implementation

### WebFetchTool class (`src/tools/web-fetch.ts`, ~215 lines)

- Extends `ZodTool<typeof WebFetchSchema>`
- Constructor accepts two optional injectables for testing:
  - `fetchHeadless?: (url: string) => Promise<HeadlessResult>` — defaults to `fetchViaHeadless()`
  - `tavilyExtract?: (url, mode, apiKey) => Promise<HeadlessResult>` — defaults to `extractViaTavily()`
- `handle()`:
  1. Resolve Tavily API key from `settings.tools.tavily.apiKey`
  2. If key present: call `tavilyWithTimeout()` (wraps `_tavilyExtract` with abort signal support)
  3. If Tavily fails or no key: call `fetchWithTimeout()` (wraps `_fetchHeadless` with abort signal support)
  4. Truncate content to `maxChars`, append `[Content truncated...]` marker

### Headless browser fallback (in `src/tools/web-fetch.ts`)

- Dynamic import of `puppeteer`: `await import('puppeteer')` — only loaded on first fallback
- Launch headless Chrome with `--no-sandbox --disable-dev-shm-usage`
- Navigate to URL, wait for `networkidle2`, 30s timeout
- Extract: `document.title` + `document.body.innerText` after stripping `script/style/noscript/nav/footer/iframe`
- Close browser + page after extraction

### Tavily Extract default (in `src/tools/web-fetch.ts`)

- Uses `@tavily/core` `extract()` with `format: mode` and `extractDepth: 'basic'`
- Returns `result.title` and `result.rawContent`

### ReadCache integration (`src/agent/tool-dispatch/middlewares/read-cache.ts`)

Caches `web_fetch` results with 5-minute TTL, keyed by `url + mode`. Same LRU eviction as the `read` cache (max 100 entries). Cached hits skip the tool entirely — saves Tavily API credits and headless browser overhead.

### Registration (`src/runtime.ts`)

```typescript
import { WebFetchTool } from './tools';
toolRegistry.register(new WebFetchTool());
```

One line, same pattern as `WebSearchTool`.

### Dependencies

- `puppeteer` — new dependency, dynamically imported only when Tavily is unavailable
- `@tavily/core` — already exists, used for `extract()`

### Testing

13 unit tests in `tests/tools/web-fetch.test.ts`:
- Schema definition (name, readonly, field types, defaults, required fields)
- Parameter validation (invalid URL, missing params, min/max bounds)
- Mock-based handle tests (tavily path, headless fallback, truncation, format, abort signal)

## Architecture Compliance

- Tool registered in `createAgentRuntime()`, not in `bin/*`
- No `any` casts — typed injectables for both extraction paths
- Uses `debugLog` not `console.log`
- File ~215 lines (under 400)
- All functions under 80 lines
- 13 unit tests covering all public API surfaces
- ReadCache middleware extended with TTL-based `web_fetch` caching (5 min)
