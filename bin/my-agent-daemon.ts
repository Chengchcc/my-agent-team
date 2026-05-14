#!/usr/bin/env bun
// bin/my-agent-daemon.ts
import { startDaemon } from '../src/daemon/daemon';

const profileId = process.argv[2] || process.env.MY_AGENT_PROFILE;
if (!profileId) {
  console.error('Usage: my-agent-daemon <profile-id>');
  console.error('   or: MY_AGENT_PROFILE=<profile-id> my-agent-daemon');
  process.exit(1);
}

console.log(`Starting daemon for profile "${profileId}"...`);
startDaemon(profileId).catch((err) => {
  console.error('Daemon failed:', err);
  process.exit(1);
});
