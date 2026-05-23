import path from 'node:path'
import fs from 'node:fs/promises'
import { homedir } from 'node:os'

export interface AgentPaths {
  readonly agentId: string
  readonly agentDir: string              // <agentsRoot>/<agentId>
  readonly logs: string                  // <agentDir>/logs
  readonly socket: string                // <agentDir>/daemon.sock
  readonly sessions: string              // <agentDir>/sessions
  readonly traces: string                // <agentDir>/traces
  readonly memory: string                // <agentDir>/memory
  readonly skills: {
    builtin: string                      // <cwd>/skills (read-only)
    agent: string                        // <agentDir>/skills
    auto: string                         // <agentDir>/skills/auto (evolution output)
  }
  readonly evolution: {
    proposals: string                    // <agentDir>/evolution/proposals
    stats: string                        // <agentDir>/evolution/stats
    state: string                        // <agentDir>/evolution/state
  }
  readonly identity: {
    readonly dir: string
    readonly file: string
    readonly bootstrap: string
    readonly archived: string
  }
}

export function defaultAgentsRoot(): string {
  return process.env.MY_AGENT_AGENTS_ROOT
    ?? process.env.MY_AGENT_PROFILE_ROOT
    ?? path.join(homedir() ?? '/tmp', '.my-agent', 'agents')
}

export function createAgentPaths(agentsRoot: string, agentId: string, opts?: {
  builtinSkillsDir?: string
}): AgentPaths {
  const agentDir = path.join(agentsRoot, agentId)
  const identityDir = path.join(agentDir, 'identity')
  const skillsAgent = path.join(agentDir, 'skills')
  return {
    agentId,
    agentDir,
    logs:     path.join(agentDir, 'logs'),
    socket:   path.join(agentDir, 'daemon.sock'),
    sessions: path.join(agentDir, 'sessions'),
    traces:   path.join(agentDir, 'traces'),
    memory:   path.join(agentDir, 'memory'),
    skills: {
      builtin: opts?.builtinSkillsDir ?? path.resolve(process.cwd(), 'skills'),
      agent: skillsAgent,
      auto:    path.join(skillsAgent, 'auto'),
    },
    identity: {
      dir: identityDir,
      file: path.join(identityDir, 'identity.md'),
      bootstrap: path.join(identityDir, 'bootstrap.md'),
      archived: path.join(identityDir, 'bootstrap.archived.md'),
    },
    evolution: {
      proposals: path.join(agentDir, 'evolution', 'proposals'),
      stats:     path.join(agentDir, 'evolution', 'stats'),
      state:     path.join(agentDir, 'evolution', 'state'),
    },
  }
}

export async function ensureAgentPaths(p: AgentPaths): Promise<void> {
  await Promise.all([
    fs.mkdir(p.identity.dir,          { recursive: true }),
    fs.mkdir(p.logs,                { recursive: true }),
    fs.mkdir(p.sessions,            { recursive: true }),
    fs.mkdir(p.traces,              { recursive: true }),
    fs.mkdir(p.memory,              { recursive: true }),
    fs.mkdir(p.skills.agent,        { recursive: true }),
    fs.mkdir(p.skills.auto,         { recursive: true }),
    fs.mkdir(p.evolution.proposals, { recursive: true }),
    fs.mkdir(p.evolution.stats,     { recursive: true }),
    fs.mkdir(p.evolution.state,     { recursive: true }),
  ])
}
