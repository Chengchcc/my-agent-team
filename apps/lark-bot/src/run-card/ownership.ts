/** ADR 0060 D3: a run card is one agent's turn, delivered by that agent's
 *  bot. In a room the ledger is shared, so a run started for a WORKER is a
 *  fact about the same conversation — but giving it this bot's card makes the
 *  worker read as the front desk, and its text then has no attribution at
 *  all. The card belongs to the bot's own agent; anything else waits for the
 *  front desk's rewrite (ADR 0059's result notice).
 *
 *  Unknown owner keeps today's behaviour: a rail that does not report the
 *  agent must not silently lose its card. */
export function isOwnAgentRun(selfAgentId: string, runAgentId: string | undefined): boolean {
  return runAgentId === undefined || runAgentId === selfAgentId;
}
