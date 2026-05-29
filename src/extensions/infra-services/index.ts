import { defineExtension } from '../../kernel/define-extension'
import { createJobSpawner } from '../../infrastructure/jobs'
import { SqliteProposalStore } from '../../infrastructure/evolution/sqlite-proposal-store'
import { SqliteSkillStatsStore } from '../../infrastructure/evolution/sqlite-skill-stats-store'
import { SqliteSkillMetaRepo } from '../../infrastructure/evolution/sqlite-skill-meta-repo'
import { openDb, runMigrations } from '../../infrastructure/_sqlite/connection'
import { evolutionMigrations } from '../../infrastructure/evolution/sqlite-evolution-schema'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createJobContextFactory } from './job-context-factory'

/**
 * Infra-services extension — registers infrastructure port implementations.
 *
 * Provides:
 *   - job-spawner: JobSpawner
 *   - proposal-store: ProposalStore (SQLite)
 *   - skill-stats-store: SkillStatsStore (SQLite)
 *   - skill-meta-repo: SkillMetaRepo (SQLite)
 */
export default () =>
  defineExtension({
    name: 'infra-services',
    enforce: 'post',

    apply: (ctx) => {
      const provider = ctx.extensions.has('provider.llm')
        ? ctx.extensions.get('provider.llm')
        : undefined

      const spawner = createJobSpawner({
        invoke: provider as any,
        chatComplete: provider ? (provider as any).complete?.bind(provider) : undefined,
        logger: ctx.logger,
      })

      const evoDir = join(ctx.paths.evolution.proposals, '..')
      mkdirSync(evoDir, { recursive: true })
      const db = openDb(join(evoDir, 'evolution.db'))
      runMigrations(db, evolutionMigrations)
      const proposals = new SqliteProposalStore(db)
      const stats = new SqliteSkillStatsStore(db)
      const meta = new SqliteSkillMetaRepo(db)

      return {
        provide: {
          'infra-services.job-spawner': () => spawner,
          'infra-services.proposal-store': () => proposals,
          'infra-services.skill-stats-store': () => stats,
          'infra-services.skill-meta-repo': () => meta,
          'infra-services.job-context-factory': () =>
            provider
              ? createJobContextFactory(provider as any, ctx.logger)
              : undefined,
        },
        dispose: () => { db.close() },
      }
    },
  })
