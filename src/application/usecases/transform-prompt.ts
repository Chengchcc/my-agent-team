// Transform-prompt usecase — pure orchestration signatures.
// No IO, no adapter imports. Prompt transformations only.

interface Prompt {
  system: string
  messages: Array<{ role: string; content: string }>
}

// Pure function: injects memory recall into system prompt.
function injectRecall(
  prompt: Prompt,
  memories: Array<{ text: string; weight: number }>,
): Prompt {
  if (memories.length === 0) {
    return prompt
  }

  const recallLines = ['<!-- recall -->']
  for (const memory of memories) {
    recallLines.push(`- [weight=${memory.weight.toFixed(2)}] ${memory.text}`)
  }
  recallLines.push('<!-- /recall -->')

  return {
    system: prompt.system + '\n' + recallLines.join('\n'),
    messages: prompt.messages,
  }
}

// Pure function: injects identity into system prompt.
function injectIdentity(
  prompt: Prompt,
  identity: Record<string, unknown>,
): Prompt {
  const keys = Object.keys(identity)
  if (keys.length === 0) {
    return prompt
  }

  const identityLines = ['<!-- identity -->']
  for (const key of keys) {
    identityLines.push(`- ${key}: ${String(identity[key])}`)
  }
  identityLines.push('<!-- /identity -->')

  return {
    system: prompt.system + '\n' + identityLines.join('\n'),
    messages: prompt.messages,
  }
}

// Pure function: strips ephemeral markers from system prompt (for internal calls).
function stripEphemeral(prompt: Prompt): Prompt {
  const ephemeralPattern = /<!-- \w+ -->[\s\S]*?<!-- \/\w+ -->\n?/g
  return {
    system: prompt.system.replace(ephemeralPattern, '').trimEnd(),
    messages: prompt.messages,
  }
}

export type { Prompt }
export { injectRecall, injectIdentity, stripEphemeral }
