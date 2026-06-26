import type { AgentSession } from "@my-agent-team/harness";

/** In-memory registry of active AgentSessions, keyed by runId.
 *  Sessions are registered by startAgentRun and looked up by the resume route. */
const sessions = new Map<string, AgentSession>();

export function registerSession(runId: string, session: AgentSession): void {
  sessions.set(runId, session);
}

export function getSession(runId: string): AgentSession | undefined {
  return sessions.get(runId);
}

export function removeSession(runId: string): void {
  sessions.delete(runId);
}

/** Dispose and remove a session. Called by reaper/cleanup paths. */
export function disposeSession(runId: string): void {
  const session = sessions.get(runId);
  if (session) {
    session.abort();
    session.dispose();
    sessions.delete(runId);
  }
}
