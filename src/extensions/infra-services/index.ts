import { defineExtension } from '../../kernel/define-extension'
import { createJobSpawner } from '../../infrastructure/jobs'
import { FsProposalStore } from '../../infrastructure/evolution/fs-proposal-store'
import { FsSkillStatsStore } from '../../infrastructure/evolution/fs-skill-stats-store'

/**
 * Infra-services extension — registers infrastructure port implementations
 * as kernel capabilities so evolution/memory can access them via
 * ctx.extensions.get().
 *
 * Provides:
 *   - job-spawner: JobSpawner (Bun.spawn or inproc, controlled by JOB_SPAWNER env)
 *   - proposal-store: ProposalStore (NDJSON fs-backed)
 *   - skill-stats-store: SkillStatsStore (JSON fs-backed)
 */
export default () =>
  defineExtension({
    name: 'infra-services',
    enforce: 'post',

    apply: (ctx) => {
      const spawner = createJobSpawner()
      const proposals = new FsProposalStore(ctx.paths.evolution.proposals)
      const stats = new FsSkillStatsStore(ctx.paths.evolution.stats)

      return {
        provide: {
          'job-spawner': () => spawner,
          'proposal-store': () => proposals,
          'skill-stats-store': () => stats,
        },
      }
    },
  })
