function escapeMd(s: string): string {
  return s.replace(/[*_~`\[\]\\]/g, c => `\\${c}`);
}

type StatusKey = 'starting' | 'working' | 'idle' | 'analyzing' | 'error';

const statusMap: Record<StatusKey, { label: string; template: string }> = {
  starting: { label: '启动中…', template: 'yellow' },
  working: { label: '工作中', template: 'blue' },
  idle: { label: '等待输入', template: 'green' },
  analyzing: { label: '正在分析…', template: 'purple' },
  error: { label: '出错', template: 'red' },
};

const CONTENT_TRUNCATION_LIMIT = 3000;
const COMMAND_DISPLAY_MAX_LENGTH = 100;
const MAX_BUTTONS_PER_GROUP = 4;
const HEADER_TITLE_MAX_LENGTH = 30;

export function buildStreamingCard(params: {
  title: string;
  markdownContent: string;
  status: 'starting' | 'working' | 'idle' | 'analyzing' | 'error';
}): string {
  const { title, markdownContent, status } = params;
  const st = statusMap[status] ?? statusMap.working;
  const elements: Record<string, unknown>[] = [];

  if (markdownContent) {
    const truncated = markdownContent.length > CONTENT_TRUNCATION_LIMIT
      ? markdownContent.slice(0, CONTENT_TRUNCATION_LIMIT) + '\n\n_(输出已截断)_'
      : markdownContent;
    elements.push({ tag: 'markdown', content: truncated });
  }

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🤖 ${escapeMd(title)} — ${st.label}` },
      template: st.template,
    },
    elements,
  };
  return JSON.stringify(card);
}

export function buildPermissionCard(params: {
  sessionId: string;
  rootId: string;
  toolName: string;
  reason: string;
  command: string;
}): string {
  const { sessionId, rootId, toolName, reason, command } = params;
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🟡 危险命令确认' },
      template: 'yellow' as const,
    },
    elements: [
      {
        tag: 'markdown',
        content: `**工具:** ${escapeMd(toolName)}\n**命令:** \`${escapeMd(command.slice(0, COMMAND_DISPLAY_MAX_LENGTH))}\`\n**原因:** ${escapeMd(reason)}`,
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 允许' },
            type: 'primary',
            value: { action: 'permission_allow', root_id: rootId, session_id: sessionId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 拒绝' },
            type: 'danger',
            value: { action: 'permission_deny', root_id: rootId, session_id: sessionId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔓 始终允许' },
            type: 'default',
            value: { action: 'permission_always', root_id: rootId, session_id: sessionId },
          },
        ],
      },
    ],
  };
  return JSON.stringify(card);
}

export function buildAskUserQuestionCard(params: {
  sessionId: string;
  rootId: string;
  header: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }>;
}): string {
  const { sessionId, rootId, header, questions } = params;
  const elements: Record<string, unknown>[] = [];

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]!;
    if (qi > 0) elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**${escapeMd(q.header)}**\n${escapeMd(q.question)}` },
    });

    const buttons = q.options.map((opt) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: opt.label },
      type: 'default' as const,
      value: {
        action: 'ask_answer',
        root_id: rootId,
        session_id: sessionId,
        question_index: String(qi),
        selected_labels: JSON.stringify([opt.label]),
      },
    }));
    elements.push({
      tag: 'action',
      actions: buttons.slice(0, MAX_BUTTONS_PER_GROUP),
    });
  }

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🔵 ${escapeMd(header.slice(0, HEADER_TITLE_MAX_LENGTH))}` },
      template: 'blue' as const,
    },
    elements,
  };
  return JSON.stringify(card);
}

export function buildResolvedCard(text: string): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '✅ 已处理' },
      template: 'green' as const,
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: escapeMd(text) } },
    ],
  };
  return JSON.stringify(card);
}

