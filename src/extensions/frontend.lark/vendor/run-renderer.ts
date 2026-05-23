/**
 * Vendored from feishu-claude-code-bridge (MIT, 2025).
 * Source: https://github.com/zarazhangrui/feishu-claude-code-bridge/blob/main/src/card/run-renderer.ts
 * Modifications:
 *   - Removed the Stop button (cancel is via /cancel slash command).
 *   - Kept idle_timeout branch for forward compatibility (unused for now).
 */
import type { Block, FooterStatus, RunState, ToolEntry } from './run-state';
import { toolBodyMd, toolHeaderText } from './tool-render';

const REASONING_MAX = 1500;
const COLLAPSE_TOOL_THRESHOLD = 3;

interface ToolGroup { kind: 'tools'; tools: ToolEntry[] }
interface TextGroup { kind: 'text'; content: string }
type Group = ToolGroup | TextGroup;

export function renderCard(state: RunState): object {
  const elements: object[] = [];

  if (state.reasoning.content) {
    elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
  }

  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'text') {
      if (group.content.trim()) elements.push(markdown(group.content));
    } else {
      elements.push(...renderToolGroup(group.tools, state.terminal !== 'running'));
    }
  }

  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_\u23F9 \u5DF2\u88AB\u4E2D\u65AD_'));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_\u23F1 ${mins} \u5206\u949F\u65E0\u54CD\u5E94,\u5DF2\u81EA\u52A8\u7EC8\u6B62_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`\u26A0\uFE0F agent \u5931\u8D25\uFF1A${state.errorMsg}`));
  } else if (state.terminal === 'done' && elements.length === 0) {
    elements.push(noteMd('_(\u672A\u8FD4\u56DE\u5185\u5BB9)_'));
  }

  if (state.terminal === 'running' && state.footer) {
    elements.push(footerStatus(state.footer));
  }

  return {
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: summaryText(state) },
    },
    body: { elements },
  };
}

function* groupBlocks(blocks: Block[]): Generator<Group> {
  let toolBuf: ToolEntry[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool') { toolBuf.push(b.tool); }
    else {
      if (toolBuf.length > 0) { yield { kind: 'tools', tools: toolBuf }; toolBuf = []; }
      yield { kind: 'text', content: b.content };
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

function renderToolGroup(tools: ToolEntry[], finalized: boolean): object[] {
  if (tools.length === 0) return [];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) return tools.map((t) => toolPanel(t, false));
  if (finalized) return [collapsedToolSummary(tools, true)];
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1];
  const out: object[] = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  if (latest) out.push(toolPanel(latest, true));
  return out;
}

function reasoningPanel(content: string, active: boolean): object {
  const title = active ? '\uD83E\uDDE0 **\u601D\u8003\u4E2D**' : '\uD83E\uDDE0 **\u601D\u8003\u5B8C\u6210,\u70B9\u51FB\u67E5\u770B**';
  return collapsiblePanel({ title, expanded: active, border: 'grey', body: truncate(content, REASONING_MAX) });
}

function toolPanel(tool: ToolEntry, expanded: boolean): object {
  return collapsiblePanel({
    title: toolHeaderText(tool), expanded,
    border: tool.status === 'error' ? 'red' : 'grey',
    body: toolBodyMd(tool) || '_\u65E0\u8F93\u51FA_',
  });
}

function collapsedToolSummary(tools: ToolEntry[], finalized: boolean): object {
  const suffix = finalized ? '(\u5DF2\u7ED3\u675F)' : '';
  const title = `\u2615 **${tools.length} \u4E2A\u5DE5\u5177\u8C03\u7528${suffix}**`;
  const headerList = tools.map((t) => `- ${toolHeaderText(t)}`).join('\n');
  return {
    tag: 'collapsible_panel', expanded: false,
    header: panelHeader(title),
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px', padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: headerList, text_size: 'notation' }],
  };
}

interface PanelOpts { title: string; expanded: boolean; border: 'grey' | 'red' | 'blue'; body: string }
function collapsiblePanel(opts: PanelOpts): object {
  return {
    tag: 'collapsible_panel', expanded: opts.expanded,
    header: panelHeader(opts.title),
    border: { color: opts.border, corner_radius: '5px' },
    vertical_spacing: '8px', padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: opts.body, text_size: 'notation' }],
  };
}

function panelHeader(titleMd: string): object {
  return {
    title: { tag: 'markdown', content: titleMd },
    vertical_align: 'center',
    icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
    icon_position: 'follow_text', icon_expanded_angle: -180,
  };
}

function markdown(content: string): object { return { tag: 'markdown', content }; }
function noteMd(content: string): object { return { tag: 'markdown', content, text_size: 'notation' }; }

function footerStatus(status: Exclude<FooterStatus, null>): object {
  const text = status === 'thinking' ? '\uD83E\uDDE0 \u6B63\u5728\u601D\u8003' : status === 'tool_running' ? '\uD83E\uDDF0 \u6B63\u5728\u8C03\u7528\u5DE5\u5177' : '\u270D\uFE0F \u6B63\u5728\u8F93\u51FA';
  return noteMd(text);
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '\u5DF2\u4E2D\u65AD';
  if (state.terminal === 'idle_timeout') return '\u5DF2\u8D85\u65F6';
  if (state.terminal === 'error') return '\u51FA\u9519';
  if (state.terminal === 'done') return '\u5DF2\u5B8C\u6210';
  if (state.footer === 'tool_running') return '\u6B63\u5728\u8C03\u7528\u5DE5\u5177';
  if (state.footer === 'streaming') return '\u6B63\u5728\u8F93\u51FA';
  return '\u601D\u8003\u4E2D';
}

function truncate(s: string, max: number): string { return s.length > max ? `${s.slice(0, max)}\u2026` : s; }
