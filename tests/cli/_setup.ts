import { beforeEach } from 'bun:test'

beforeEach(() => {
  delete process.env.MY_AGENT_HOME
  delete process.env.MY_AGENT_AGENTS_ROOT
  delete process.env.MY_AGENT_PROFILE
  delete process.env.MY_AGENT_PROFILE_ROOT
  delete process.env.MY_AGENT_VERBOSE
  delete process.env.MY_AGENT_DEBUG
})
