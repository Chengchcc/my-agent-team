import type { DaemonSession } from '../im/types';
import type { SessionManager } from './session-manager';

const MS_PER_SECOND = 1000;

export const DAEMON_COMMANDS = new Set(['/repo', '/restart', '/close', '/status', '/skip', '/help']);

export async function handleCommand(
  cmd: string,
  _args: string,
  ds: DaemonSession,
  sessionManager: SessionManager,
  sessionReply: (anchor: string, content: string, msgType?: string) => Promise<string>,
): Promise<boolean> {
  const anchor = ds.scope === 'chat' ? ds.chatId : ds.session.rootMessageId;

  switch (cmd) {
    case '/status': {
      const uptime = Math.floor((Date.now() - ds.spawnedAt) / MS_PER_SECOND);
      const msg = `会话状态: 🟢 活跃\n运行时间: ${uptime}s\n工作目录: ${ds.workingDir ?? 'N/A'}`;
      await sessionReply(anchor, msg);
      return true;
    }
    case '/close': {
      sessionManager.removeSession(anchor);
      await sessionReply(anchor, '会话已关闭。');
      return true;
    }
    case '/restart': {
      await sessionReply(anchor, '🔄 正在重启...');
      return true;
    }
    case '/help': {
      await sessionReply(anchor, '可用命令: /status, /restart, /close, /repo, /help');
      return true;
    }
    case '/repo':
    case '/skip': {
      return false;
    }
  }
  return false;
}

export function parseSlashCommandInvocation(content: string): { cmd: string; content: string } | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) return null;
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex === -1) return { cmd: trimmed, content: '' };
  return { cmd: trimmed.slice(0, spaceIndex), content: trimmed.slice(spaceIndex + 1) };
}
