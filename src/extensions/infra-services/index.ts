import { defineExtension } from '../../kernel/define-extension'
import { createJobSpawner } from '../../infrastructure/jobs'
import { SqliteProposalStore } from '../../infrastructure/evolution/sqlite-proposal-store'
import { SqliteSkillStatsStore } from '../../infrastructure/evolution/sqlite-skill-stats-store'
import { SqliteSkillMetaRepo } from '../../infrastructure/evolution/sqlite-skill-meta-repo'
import { openDb, runMigrations } from '../../infrastructure/_sqlite/connection'
import { evolutionMigrations } from '../../infrastructure/evolution/sqlite-evolution-schema'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderInvoke } from '../../application/ports/provider'
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
      const providerInvoke = ctx.extensions.has('provider.llm')
        ? ctx.extensions.get<ProviderInvoke>('provider.llm')
        : undefined

      const spawner = createJobSpawner({
        invoke: providerInvoke,
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
          'job-spawner': () => spawner,
          'proposal-store': () => proposals,
          'skill-stats-store': () => stats,
          'skill-meta-repo': () => meta,
          'job-context-factory': () =>
            providerInvoke
              ? createJobContextFactory(providerInvoke, ctx.logger)
              : undefined,
        },
        dispose: () => { db.close() },
      }
    },
  })
