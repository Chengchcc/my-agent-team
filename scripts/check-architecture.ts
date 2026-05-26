#!/usr/bin/env bun
/**
 * Architecture constraint checks. Runs in stop hook and CI.
 * Any violation exits(1).
 */
import { Project, SyntaxKind } from 'ts-morph';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const violations: string[] = [];
const v = (msg: string) => violations.push(msg);

const project = new Project({ tsConfigFilePath: 'tsconfig.json', skipAddingFilesFromTsConfig: false });

// ────────────────────────────────────────────
// Rule A1: bin/*.ts must not directly new Agent / ToolRegistry / ContextManager / *Provider
// ────────────────────────────────────────────
const forbiddenCtors = ['Agent', 'ToolRegistry', 'ContextManager', 'ClaudeProvider', 'OpenAIProvider'];
for (const f of project.getSourceFiles('bin/**/*.ts')) {
  f.getDescendantsOfKind(SyntaxKind.NewExpression).forEach(ne => {
    const name = ne.getExpression().getText();
    if (forbiddenCtors.includes(name)) {
      v(`[A1] ${f.getBaseName()}:${ne.getStartLineNumber()} — bin/ must not directly new ${name}, use createAgentRuntime()`);
    }
  });
}

// ────────────────────────────────────────────
// Rule B1: No new as any / : any
// ────────────────────────────────────────────
const anyBaseline = existsSync('.any-baseline.json')
  ? JSON.parse(readFileSync('.any-baseline.json', 'utf8'))
  : { total: Infinity };

let anyCount = 0;
for (const f of project.getSourceFiles('src/**/*.{ts,tsx}')) {
  const text = f.getFullText();
  const matches = text.match(/\b(as\s+any|:\s*any\b|<any>)/g);
  if (matches) anyCount += matches.length;
}
if (anyCount > anyBaseline.total) {
  v(`[B1] any usage count ${anyCount} exceeds baseline ${anyBaseline.total} (added ${anyCount - anyBaseline.total})`);
}

// ────────────────────────────────────────────
// Rule C1: syncTodoFromContext call sites must not increase
// ────────────────────────────────────────────
const syncTodoBaseline = 6;
let syncTodoCount = 0;
for (const f of project.getSourceFiles('src/**/*.ts')) {
  if (f.getBaseName().includes('context')) continue;
  const matches = f.getFullText().match(/syncTodoFromContext/g);
  if (matches) syncTodoCount += matches.length;
}
if (syncTodoCount > syncTodoBaseline) {
  v(`[E1] syncTodoFromContext call sites ${syncTodoCount} exceeds baseline ${syncTodoBaseline}`);
}

// ────────────────────────────────────────────
// Rule D1: ToolDispatcher method set is frozen
// ────────────────────────────────────────────
const allowedDispatcherMethods = new Set([
  'dispatch', 'executeSingle', 'buildMiddlewareChain',
  'withTimeout', 'serializeAndTruncate',
  'dispatchSequential', 'dispatchParallelBatch', 'dispatchParallelStreaming',
]);
const dispatcherFile = project.getSourceFile('src/agent/tool-dispatch/dispatcher.ts');
if (dispatcherFile) {
  const cls = dispatcherFile.getClass('ToolDispatcher');
  if (cls) {
    for (const m of cls.getMethods()) {
      if (!allowedDispatcherMethods.has(m.getName())) {
        v(`[D1] ToolDispatcher new method ${m.getName()}, frozen period — no new methods (see CLAUDE.md § D)`);
      }
    }
  }
}

// ────────────────────────────────────────────
// Rule C2: Agent constructor middleware field must not be used
// ────────────────────────────────────────────
for (const f of project.getSourceFiles('src/**/*.ts')) {
  if (f.getBaseName() === 'Agent.ts') continue;
  f.getDescendantsOfKind(SyntaxKind.PropertyAssignment).forEach(pa => {
    if (pa.getName() === 'middleware' && pa.getParent()?.getParent()?.getText().includes('new Agent')) {
      v(`[C2] ${f.getBaseName()}:${pa.getStartLineNumber()} — Agent deprecated middleware field is forbidden`);
    }
  });
}

// ────────────────────────────────────────────
// Rule F1: No console.log (warn/error allowed)
// CLI files are exempt — they write to the terminal by design.
// ────────────────────────────────────────────
for (const f of project.getSourceFiles('src/**/*.{ts,tsx}')) {
  if (f.getFilePath().includes('/cli/')) continue;
  f.getDescendantsOfKind(SyntaxKind.CallExpression).forEach(ce => {
    if (ce.getExpression().getText() === 'console.log') {
      v(`[F1] ${f.getFilePath()}:${ce.getStartLineNumber()} — console.log is forbidden, use debugLog`);
    }
  });
}

// ────────────────────────────────────────────
// Rule G1: File size (soft rule, eslint already enforces)
// ────────────────────────────────────────────
for (const f of project.getSourceFiles('src/**/*.{ts,tsx}')) {
  const lines = f.getEndLineNumber();
  if (lines > 400) {
    v(`[G1] ${f.getFilePath()} has ${lines} lines > 400, consider splitting`);
  }
}

// ────────────────────────────────────────────
// Rule A2: defaultSystemPrompt string must only appear in one place
// ────────────────────────────────────────────
const promptSig = 'You are Claude Code, an interactive AI coding assistant';
const hits: string[] = [];
for (const f of project.getSourceFiles(['src/**/*.ts', 'bin/**/*.ts'])) {
  if (f.getFullText().includes(promptSig)) hits.push(f.getFilePath());
}
if (hits.length > 1) {
  v(`[A2] defaultSystemPrompt defined in multiple places, consolidate to src/config/default-prompts.ts:\n  ${hits.join('\n  ')}`);
}

// ────────────────────────────────────────────
// Rule P5-1: DataPlaneEvent must not be defined in extensions/dataplane
// ────────────────────────────────────────────
for (const f of project.getSourceFiles('src/extensions/dataplane/**')) {
  const text = f.getFullText();
  if (text.includes('DataPlaneEvent') && text.includes('interface DataPlaneEvent')) {
    v(`[P5-1] ${f.getFilePath()} — DataPlaneEvent must be defined in application/contracts/, not extensions/dataplane/`);
  }
}

// ────────────────────────────────────────────
// Rule P5-2: No new public contract types in src/types.ts
// ────────────────────────────────────────────
const typesFile = project.getSourceFile('src/types.ts');
const P5_2_ALLOWED = new Set([
  'ToolContext', 'Tool', 'ToolImplementation',
  'Message', 'ToolCall',
  'ContentBlock',
  'Session',
  'AgentConfig', 'AgentContext', 'Middleware', 'AgentMiddleware',
]);
if (typesFile) {
  const typesText = typesFile.getFullText();
  const exportMatches = typesText.match(/export\s+(interface|type)\s+\w+/g) ?? [];
  for (const match of exportMatches) {
    const name = match.replace('export ', '').replace('interface ', '').replace('type ', '');
    if (!P5_2_ALLOWED.has(name)) {
      v(`[P5-2] src/types.ts — new exported type '${name}' detected. New public contracts must go in application/contracts/`);
    }
  }
}

// ────────────────────────────────────────────
// Rule A3: src/types.ts is a deprecated shim — ≤8 exports, all with @deprecated
// ────────────────────────────────────────────
const A3_CONTENT_BLOCK_OK = 'ContentBlock'; // inherited from P-5, will be removed P-6.1
if (typesFile) {
  const exportCount = typesFile.getExportDeclarations().length;
  if (exportCount > 8) {
    v(`[A3] src/types.ts has ${exportCount} export declarations (>8 allowed). types.ts must be a ≤30-line deprecated shim.`);
  }
  const text = typesFile.getFullText();
  // Find export type { ... } lines and check if preceding comment contains @deprecated
  const exportLines = text.split('\n')
    .map((line, i) => ({ line, idx: i }))
    .filter(({ line }) => /^\s*export\s+(type\s+)?\{/.test(line));
  for (const { line, idx } of exportLines) {
    // Check the line or the line above for @deprecated
    const prevLine = idx > 0 ? text.split('\n')[idx - 1] : '';
    if (!line.includes(A3_CONTENT_BLOCK_OK) && !prevLine.includes('@deprecated') && !line.includes('@deprecated')) {
      v(`[A3] src/types.ts:${idx + 1} — export must have @deprecated JSDoc`);
    }
  }
}

// ────────────────────────────────────────────
// Rule A4: ContentBlock must be imported from application/contracts/**
// ────────────────────────────────────────────
for (const f of project.getSourceFiles('src/**/*.{ts,tsx}')) {
  for (const imp of f.getImportDeclarations()) {
    const namedImports = imp.getNamedImports().map(n => n.getName());
    if (namedImports.includes('ContentBlock')) {
      const modSpec = imp.getModuleSpecifierValue();
      if (modSpec.includes('/types') || modSpec.endsWith('types')) {
        v(`[A4] ${f.getFilePath()}:${imp.getStartLineNumber()} — ContentBlock must be imported from application/contracts, not ${modSpec}`);
      }
    }
  }
}

// ────────────────────────────────────────────
// Rule A5: No StringLiteral raw emit of contracted event names
// ────────────────────────────────────────────
const CONTRACTED_EVENT_NAMES = new Set([
  'provider.selected', 'llm.delta',
  'memory.summary.ready', 'memory.summarized',
  'evolution.proposal.accepted', 'evolution.proposal.rejected',
  'skills.reloaded',
  'session.created', 'turn.started', 'turn.completed', 'turn.failed',
  'tool.executed',
  'permission.required',
  'identity.changed',
  'attach.changed', 'session.resumed', 'session.closed', 'session.renamed',
  'user.question.answered', 'system.shutdown.requested',
  'input.cancelled', 'turn.cancelled',
]);
// A5: dataplane/index.ts is a forwarding bridge — legitimate raw bus.on wrapping
const A5_WHITELIST_FILES = new Set(['dataplane/index.ts']);
for (const f of project.getSourceFiles('src/**/*.{ts,tsx}')) {
  if (f.getFilePath().includes('dataplane/index.ts')) continue;
  for (const ce of f.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const prop = ce.getExpression();
    if (prop.getKind() === SyntaxKind.PropertyAccessExpression) {
      const pa = prop.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      if (pa.getName() === 'emit') {
        // contractBus.emit() wraps payloads in createEvent() internally — allowed
        const objectText = pa.getExpression().getText();
        if (objectText === 'contractBus' || objectText.endsWith('.contractBus')) continue;

        const args = ce.getArguments();
        if (args.length > 0 && args[0].getKind() === SyntaxKind.StringLiteral) {
          const eventName = args[0].asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
          if (CONTRACTED_EVENT_NAMES.has(eventName)) {
            v(`[A5] ${f.getFilePath()}:${ce.getStartLineNumber()} — raw emit('${eventName}') is forbidden for contracted events; use contractBus.emit(createEvent(...))`);
          }
        }
      }
    }
  }
}

// ────────────────────────────────────────────
// Rule A6: No handcrafted EventEnvelope object literals (type+payload mandatory + ≥4 total)
// ────────────────────────────────────────────
const ENVELOPE_KEYS = ['type', 'version', 'payload', 'ts', 'sessionId', 'turnId'];
// Only createEvent() and event-envelope helpers may construct envelopes
const A6_WHITELIST_PATHS = [
  'event-envelope.ts', 'codec.ts',
  'history-record.ts', // HistoryRecordV1 factory, not EventEnvelope
  'append-history.ts', // same
  'turn-runner.ts', // TurnEvent domain object, not EventEnvelope
  'trace-event.ts', // TraceEvent factory, not EventEnvelope
  'dataplane/index.ts', // dataplane forwarding bridge — P-6 preserves it
  'widget-events.ts', // InlineBlockV1 factory, not EventEnvelope
];
for (const f of project.getSourceFiles('src/**/*.{ts,tsx}')) {
  if (A6_WHITELIST_PATHS.some(p => f.getFilePath().includes(p))) continue;
  for (const ol of f.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    const matchedKeys: string[] = [];
    let hasType = false;
    let hasPayload = false;
    for (const prop of ol.getProperties()) {
      const name = (prop.getKind() === SyntaxKind.PropertyAssignment || prop.getKind() === SyntaxKind.ShorthandPropertyAssignment)
        ? (prop.getSymbol()?.getName() ?? '')
        : '';
      if (ENVELOPE_KEYS.includes(name)) {
        matchedKeys.push(name);
        if (name === 'type') hasType = true;
        if (name === 'payload') hasPayload = true;
      }
    }
    if (hasType && hasPayload && matchedKeys.length >= 4) {
      v(`[A6] ${f.getFilePath()}:${ol.getStartLineNumber()} — handcrafted EventEnvelope-like object (keys: ${matchedKeys.join(', ')}) is forbidden; use createEvent()`);
    }
  }
}

// ────────────────────────────────────────────
// Rule A7: Agent legacy types must be imported from extensions/skills/internal/agent-legacy
// ────────────────────────────────────────────
const AGENT_LEGACY_TYPES = new Set(['AgentConfig', 'AgentContext', 'Middleware', 'AgentMiddleware']);
for (const f of project.getSourceFiles('src/**/*.{ts,tsx}')) {
  // Skip the legacy definition file itself
  if (f.getFilePath().includes('extensions/skills/internal/agent-legacy')) continue;
  // Skip the deprecated shim
  if (f.getFilePath().endsWith('types.ts') && f.getFilePath().includes('/src/types')) continue;
  for (const imp of f.getImportDeclarations()) {
    const modSpec = imp.getModuleSpecifierValue();
    // Skip imports from the correct location or from the deprecated shim
    if (modSpec.includes('agent-legacy') || modSpec.includes('/types') || modSpec === 'types') continue;
    for (const ni of imp.getNamedImports()) {
      if (AGENT_LEGACY_TYPES.has(ni.getName())) {
        v(`[A7] ${f.getFilePath()}:${imp.getStartLineNumber()} — ${ni.getName()} must be imported from extensions/skills/internal/agent-legacy, not ${modSpec}`);
      }
    }
  }
}

// ────────────────────────────────────────────
// Rule A8: Relative import depth must not exceed 4 levels
// ────────────────────────────────────────────
for (const f of project.getSourceFiles('src/**/*.{ts,tsx}')) {
  for (const imp of f.getImportDeclarations()) {
    const modSpec = imp.getModuleSpecifierValue();
    if (modSpec.startsWith('.')) {
      const depth = (modSpec.match(/\.\.\//g) ?? []).length;
      if (depth > 4) {
        v(`[A8] ${f.getFilePath()}:${imp.getStartLineNumber()} — relative import depth ${depth} exceeds 4: ${modSpec}`);
      }
    }
  }
}

// ── A18: CLI-bearing extension manifest enforcement ────────────────────────

const CLI_BEARING_EXTS = ['trace', 'memory', 'skills', 'evolution', 'mcp'] as const

function assertCliManifestExported(ext: string): void {
  try {
    const src = readFileSync(`src/extensions/${ext}/index.ts`, 'utf8')
    if (!/export\s+const\s+cliManifest\s*:\s*CliManifest/.test(src)) {
      v(`A18.1: ext "${ext}" must export const cliManifest: CliManifest`)
    }
    if (!/AssertHasCliManifest/.test(src)) {
      v(`A18.2: ext "${ext}" must include AssertHasCliManifest type guard`)
    }
  } catch {
    v(`A18.0: ext "${ext}" index.ts not found or unreadable`)
  }
}

function assertImportedInRegistry(ext: string): void {
  const registrySrc = readFileSync('src/cli/cli-registry.ts', 'utf8')
  // Check that cliManifest from this ext is imported (not commented out)
  if (!new RegExp(`import\\s+\\{[^}]*cliManifest[^}]*\\}\\s+from\\s+'\\.\\./extensions/${ext}'`).test(registrySrc)) {
    v(`A18.3: ext "${ext}" cliManifest must be imported (not commented) in src/cli/cli-registry.ts`)
  }
}

for (const ext of CLI_BEARING_EXTS) {
  assertCliManifestExported(ext)
  assertImportedInRegistry(ext)
}

// A18.5 — SlashCommand type must be defined exactly once, in src/application/slash/slash-types.ts.
//          Any layer may import from there.
function srcGrep(pattern: string): string[] {
  try {
    const output = execSync(`grep -rl '${pattern}' src/`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
function findFiles(re: RegExp, root: string): string[] {
  const out: string[] = [];
  for (const f of project.getSourceFiles(`${root}/**/*.ts`)) {
    if (re.test(f.getFullText())) out.push(f.getFilePath());
  }
  return out;
}
const slashDefines = findFiles(/^export\s+(interface|type)\s+SlashCommand\b/m, 'src');
const slashAllowed = slashDefines.filter(p => p.endsWith('src/application/slash/slash-types.ts'));
if (slashDefines.length !== 1 || slashAllowed.length !== 1) {
  v(`A18.5: SlashCommand must be defined exactly once in src/application/slash/slash-types.ts (found ${slashDefines.length})`);
}

// A18.6 — CliManifest type must not be imported outside src/cli/ or ext index.ts
const cliImporters = srcGrep('import.*CliManifest');
for (const f of cliImporters) {
  const ok = f.startsWith('src/cli/') || /^src\/extensions\/[^/]+\/index\.ts$/.test(f);
  if (!ok) v(`A18.6: CliManifest imported in unexpected location: ${f}`);
}

// ── A19: Widget system guards ──────────────────────────────────────────

// A19.2 — only frontend.tui may import ink/react (checked in extensions + application)
for (const f of [
  ...project.getSourceFiles('src/extensions/**/*.{ts,tsx}'),
  ...project.getSourceFiles('src/application/**/*.{ts,tsx}'),
]) {
  const fp = f.getFilePath();
  if (fp.includes('frontend.tui')) continue;
  for (const imp of f.getImportDeclarations()) {
    const m = imp.getModuleSpecifierValue();
    if (m === 'ink' || m === 'react' || (m ?? '').startsWith('ink-')) {
      v(`A19.2: only frontend.tui may import ink/react: ${fp}:${imp.getStartLineNumber()}`);
    }
  }
}

// A19.3 — widget-payloads.ts must be type-only (no const/let/var/function/class)
for (const f of project.getSourceFiles('src/extensions/*/widget-payloads.ts')) {
  const src = f.getFullText();
  if (/^(const|let|var|function|class)\s/m.test(src)) {
    v(`A19.3: ${f.getFilePath()} must be type-only (no runtime code)`);
  }
}

// A19.6 — widget-payloads.ts must contain declare module of widget-payload-map
for (const f of project.getSourceFiles('src/extensions/*/widget-payloads.ts')) {
  const src = f.getFullText();
  if (!/declare\s+module\s+['"][^'"]*widget-payload-map/.test(src)) {
    v(`A19.6: ${f.getFilePath()} must contain declare module of widget-payload-map`);
  }
}

// A19.7 — widget-registry must side-effect import every widget-payloads
// Uses regex to tolerate quote style variations and whitespace.
const wplFiles = project.getSourceFiles('src/extensions/*/widget-payloads.ts');
if (wplFiles.length > 0) {
  let registrySrc = '';
  try {
    registrySrc = readFileSync('src/extensions/frontend.tui/widgets/widget-registry.ts', 'utf8');
  } catch { /* registry file not found, handled separately */ }
  for (const f of wplFiles) {
    const fp = f.getFilePath();
    const m = fp.match(/src\/extensions\/([^/]+)\//);
    const extName = m?.[1]!;
    const pattern = new RegExp(`import\\s+['"](\\.{1,3}/)+${extName}/widget-payloads['"]`);
    if (!pattern.test(registrySrc)) {
      v(`A19.7: widget-registry must side-effect import ${extName}/widget-payloads`);
    }
  }
}

// A19.1 — every widget declared in WidgetPayloadMap must be in WIDGETS
// (TS types enforce this already; text scan is backup against @ts-ignore/as-cast bypass)
try {
  const widgetsSrc = readFileSync('src/extensions/frontend.tui/widgets/widget-registry.ts', 'utf8')
  // Extract widget names from WidgetPayloadMap entries added via declare module
  const payFiles = project.getSourceFiles('src/extensions/*/widget-payloads.ts')
  for (const f of payFiles) {
    const matches = f.getFullText().matchAll(/'([^']+)'\s*[?:]\s*\w+Payload/g)
    for (const m of matches) {
      const name = m[1]!
      if (!widgetsSrc.includes(`'${name}'`) && !widgetsSrc.includes(`"${name}"`)) {
        v(`A19.1: widget "${name}" declared but not in WIDGETS registry`)
      }
    }
  }
} catch { /* registry file not yet created */ }

// A19.8 — hooks/ must not contain ext protocol names (permission, ask-user-question, etc.)
const hookFiles = project.getSourceFiles('src/extensions/frontend.tui/hooks/*.ts');
const EXT_PROTOCOL_PATTERNS = /request\.permission|request\.ask-user-question|permission\.|ask\.user\.question/i;
for (const f of hookFiles) {
  if (EXT_PROTOCOL_PATTERNS.test(f.getFullText())) {
    v(`A19.8: ${f.getFilePath()} contains ext protocol patterns — must live in overlays/impls/<name>/`);
  }
}

// A19.5 — App.tsx must wire overlays through OverlayHost, not import individual overlay components
const appSrc = readFileSync('src/extensions/frontend.tui/App.tsx', 'utf8');

const FORBIDDEN_OVERLAY_IMPORT = /from\s+['"][^'"]*overlays\/impls\/overlay-(permission|ask-user-question)\/overlay-[^'"]+['"]/;
if (FORBIDDEN_OVERLAY_IMPORT.test(appSrc)) {
  v(`A19.5: App.tsx must not import OverlayPermission/OverlayAskUserQuestion directly; use OverlayHost instead`);
}

if (!/import\s+\{\s*OverlayHost\s*\}/.test(appSrc)) {
  v(`A19.5: App.tsx must import { OverlayHost } from './overlays/overlay-host'`);
}

try {
  const hostSrc = readFileSync('src/extensions/frontend.tui/overlays/overlay-host.tsx', 'utf8');
  if (!/OVERLAYS/.test(hostSrc)) {
    v(`A19.5: overlay-host.tsx must reference OVERLAYS from overlay-registry`);
  }
} catch { /* overlay-host.tsx not yet created */ }

// A20 — application/slash/ must not import from extensions/, kernel/, infrastructure/, cli/, interface/.
//        (Scoped to slash subsystem for this PR; broaden to full application/ in follow-up.)
for (const f of project.getSourceFiles('src/application/slash/**/*.ts')) {
  for (const imp of f.getImportDeclarations()) {
    const target = imp.getModuleSpecifierSourceFile()?.getFilePath() ?? '';
    const banned = ['/src/extensions/', '/src/kernel/', '/src/infrastructure/', '/src/cli/', '/src/interface/'];
    for (const seg of banned) {
      if (target.includes(seg)) {
        v(`A20: application/ may not import from ${seg.slice(1, -1)}: ${f.getFilePath()}:${imp.getStartLineNumber()}`);
      }
    }
  }
}

// ────────────────────────────────────────────
// Rule L5: Per-session events emitted without opts (missing sessionId)
// ────────────────────────────────────────────
const L5_PER_SESSION_EVENTS = new Set([
  'llm.delta', 'turn.started', 'turn.completed', 'turn.failed',
  'tool.executed', 'wave.completed',
  'permission.required', 'permission.resolved',
  'ask-user-question.required', 'ask-user-question.resolved',
])
// Dataplane bridge forwards events from raw bus; it legitimately handles opts-less emits.
const L5_WHITELIST = new Set(['dataplane/index.ts', 'extract-payload.ts'])
for (const f of project.getSourceFiles('src/**/*.{ts,tsx}')) {
  if (L5_WHITELIST.has(f.getBaseName()) || f.getFilePath().includes('dataplane/')) continue
  for (const ce of f.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const prop = ce.getExpression()
    if (prop.getKind() === SyntaxKind.PropertyAccessExpression) {
      const pa = prop.asKindOrThrow(SyntaxKind.PropertyAccessExpression)
      if (pa.getName() !== 'emit') continue
      const args = ce.getArguments()
      if (args.length < 2) continue
      if (args[0].getKind() !== SyntaxKind.StringLiteral) continue
      const eventName = args[0].asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue()
      if (!L5_PER_SESSION_EVENTS.has(eventName)) continue
      // Must have at least 3 args (type, payload, opts)
      if (args.length < 3) {
        v(`[L5] ${f.getFilePath()}:${ce.getStartLineNumber()} — emit('${eventName}', ...) is a per-session event; must pass { sessionId, turnId } as third arg`)
      }
    }
  }
}

// ────────────────────────────────────────────
// Output
// ────────────────────────────────────────────
if (violations.length) {
  console.error('\n❌ Architecture constraint violations:\n');
  violations.forEach(x => console.error('  ' + x));
  console.error(`\n${violations.length} violation(s). See CLAUDE.md architecture constitution.\n`);
  process.exit(1);
}
console.log('✅ All architecture constraints passed');
