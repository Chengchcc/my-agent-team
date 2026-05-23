import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'

export interface HomePaths {
  readonly homeRoot: string
  readonly agentsRoot: string
  readonly registryDb: string
  readonly trash: string
}

/** @public — resolves home root from env or OS home */
export function defaultHomeRoot(): string {
  if (process.env.MY_AGENT_HOME) return process.env.MY_AGENT_HOME
  if (process.env.MY_AGENT_AGENTS_ROOT) {
    return process.env.MY_AGENT_AGENTS_ROOT.replace(/\/agents\/?$/, '')
  }
  return path.join(os.homedir() ?? '/tmp', '.my-agent')
}

export function createHomePaths(homeRoot: string = defaultHomeRoot()): HomePaths {
  return {
    homeRoot,
    agentsRoot: path.join(homeRoot, 'agents'),
    registryDb: path.join(homeRoot, 'agents.db'),
    trash: path.join(homeRoot, 'trash'),
  }
}

export async function ensureHomePaths(p: HomePaths): Promise<void> {
  await Promise.all([
    fs.mkdir(p.agentsRoot, { recursive: true }),
    fs.mkdir(p.trash, { recursive: true }),
  ])
}
