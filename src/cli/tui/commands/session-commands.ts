import type { SlashCommand } from '../command-registry';
import type { SessionStore } from '../../../session/store';
import type { CommandHandlerContext } from '../types';
import { useTuiStore } from '../state/store';

/**
 * Handle /resume command - list sessions or load specific session
 */
async function handleResume(
  ctx: CommandHandlerContext
): Promise<void> {
  const { sessionStore, agent, refreshMessages, onOutput, args } = ctx;

  // No arguments - open interactive session picker
  if (!args.trim()) {
    const sessions = await sessionStore.listSessions();
    useTuiStore.getState().openSessionPicker(sessions);
    return;
  }

  // Load specific session
  const searchId = args.trim();

  try {
    const sessions = await sessionStore.listSessions();
    // Find by prefix match
    const matched = sessions.find(s => s.id.startsWith(searchId));

    if (!matched) {
      onOutput(`No session found matching ID: ${searchId}`);
      return;
    }

    const messages = await sessionStore.loadSession(matched.id);
    // Clear current context
    agent.clear();
    // Add all loaded messages to context
    const contextManager = agent.getContextManager();
    for (const msg of messages) {
      contextManager.addMessage(msg);
    }
    // Set as current session
    sessionStore.setCurrentSessionId(matched.id);
    // Refresh UI
    refreshMessages();
    onOutput(`Resumed session ${matched.id} (${matched.messageCount} messages)`);
  } catch (error) {
    onOutput(`Failed to load session: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Handle /save command - force save current session
 */
async function handleSave(
  ctx: CommandHandlerContext
): Promise<void> {
  const { sessionStore, agent, onOutput } = ctx;
  const sessionId = sessionStore.getCurrentSessionId();
  if (!sessionId) {
    onOutput('No active session to save.');
    return;
  }

  try {
    const messages = agent.getContext().messages;
    await sessionStore.saveSession(sessionId, messages);
    onOutput(`Saved session ${sessionId} (${messages.length} messages)`);
  } catch (error) {
    onOutput(`Failed to save session: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Handle /forget command - delete a session
 */
async function handleForget(
  ctx: CommandHandlerContext
): Promise<void> {
  const { sessionStore, onOutput, args } = ctx;
  const searchId = args.trim();
  if (!searchId) {
    onOutput('Please provide a session ID: /forget <id>');
    return;
  }

  try {
    const sessions = await sessionStore.listSessions();
    const matched = sessions.find(s => s.id.startsWith(searchId));

    if (!matched) {
      onOutput(`No session found matching ID: ${searchId}`);
      return;
    }

    await sessionStore.deleteSession(matched.id);

    // If we deleted the current session, create a new one
    if (sessionStore.getCurrentSessionId() === matched.id) {
      const newMeta = sessionStore.createNewSession();
      onOutput(`Deleted session ${matched.id} and created new session ${newMeta.id}`);
    } else {
      onOutput(`Deleted session ${matched.id}`);
    }
  } catch (error) {
    onOutput(`Failed to delete session: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get all built-in session commands
 */
export function getSessionCommands(_sessionStore: SessionStore): SlashCommand[] {
  return [
    {
      name: 'resume',
      description: 'List saved sessions or resume a saved session: /resume [id]',
      type: 'builtin',
      handler: handleResume,
    },
    {
      name: 'save',
      description: 'Force-save current session',
      type: 'builtin',
      handler: handleSave,
    },
    {
      name: 'forget',
      description: 'Delete a saved session: /forget <id>',
      type: 'builtin',
      handler: handleForget,
    },
  ];
}
