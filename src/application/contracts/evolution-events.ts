// ── evolution.proposal.accepted ───────────────────────────────────────────────

export interface EvolutionProposalAcceptedV1 {
  id: string;
}

// ── evolution.proposal.rejected ───────────────────────────────────────────────

export interface EvolutionProposalRejectedV1 {
  id: string;
  reason?: string;
}

// ── skills.reloaded ───────────────────────────────────────────────────────────
// Two emit points use different shapes (skills ext: numeric counts,
// evolution ext: string arrays). Keep schema permissive until normalized.

export interface SkillsReloadedV1 {
  added: unknown;
  removed: unknown;
  updated: unknown;
}

// ── evolution.review.started ─────────────────────────────────────────────────

export interface EvolutionReviewStartedV1 {
  runId: string;
  tier: 'tier0' | 'tier2';
  skillName?: string;
}

// ── evolution.review.completed ──────────────────────────────────────────────

export interface EvolutionReviewCompletedV1 {
  runId: string;
  tier: 'tier0' | 'tier2';
  outcome: 'accepted' | 'rejected' | 'inconclusive';
  skillName?: string;
}

// ── evolution.review.failed ──────────────────────────────────────────────────

export interface EvolutionReviewFailedV1 {
  runId: string;
  tier: 'tier0' | 'tier2';
  message: string;
}
