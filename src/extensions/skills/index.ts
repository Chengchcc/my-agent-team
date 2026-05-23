import { defineExtension } from '../../kernel/define-extension'
import type { HookHandler } from '../../kernel/define-extension'
import { createEvent } from '../../application/contracts'
import { asContractBus } from '../../application/event-bus/contract-bus'
import { createSkillDescriptor } from '../../domain/skill-descriptor'
import type { SkillDescriptor } from '../../domain/skill-descriptor'
import { SkillLoader } from './loader'
import type { SkillInfo } from './loader'
import type { CliManifest } from '../../cli/cli-types'
import type { AssertHasCliManifest } from '../../cli/assert-cli-bearing'

export const cliManifest: CliManifest = {
  name: 'skills',
  description: 'List and manage agent skills',
  usage: [
    '  my-agent skills list [--scope builtin|agent]',
    '  my-agent skills reload',
  ].join('\n'),
  handler: async (argv, ctx) => {
    const sub = argv[0]
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- default handles undefined
    switch (sub) {
      case 'list': {
        const scope = argv.includes('--scope') ? argv[argv.indexOf('--scope') + 1] : undefined
        const result = await ctx.rpc('skills.list', scope ? { scope } : undefined)
        const data = result as { skills: Array<{ name: string; description: string; scope: string }> }
        if (data.skills.length === 0) {
          ctx.out('No skills loaded.\n')
          return
        }
        for (const s of data.skills) {
          ctx.out(`${s.name.padEnd(24)} ${s.scope.padEnd(10)} ${s.description}\n`)
        }
        return
      }
      case 'reload': {
        const result = await ctx.rpc('skills.reload')
        const data = result as { added: number; removed: number; updated: number }
        ctx.out(`Reloaded: ${data.added} added, ${data.removed} removed, ${data.updated} updated\n`)
        return
      }
      default:
        ctx.err(`unknown subcommand: ${sub ?? '(none)'}\n`)
        ctx.err(cliManifest.usage + '\n')
        process.exit(2)
    }
  },
}

// Compile-time assertion: this module exports cliManifest
/**
 * @internal — compile-time satisfies check that this module exposes a CliManifest;
 * has no runtime consumer by design.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- typeof import pattern required for AssertHasCliManifest
export type _CheckCliManifest = AssertHasCliManifest<typeof import('./index')>

export type SkillsExtOptions = {
  /** Override builtin skills directory (default: <cwd>/skills). */
  builtinDir?: string
  /** Override agent skills directory (default: <agentDir>/skills). */
  agentDir?: string
  /** Additional skill paths from config. */
  extraPaths?: string[]
}

/**
 * Skills extension -- loads SKILL.md files from builtin + agent dirs,
 * registers them as SkillDescriptors, and resolves them as tools.
 *
 * Skill sources (priority: agent > extra > builtin):
 *   - builtin: project root skills/ directory (shipped with code, read-only)
 *   - profile: daemon profile's skills/ directory (user-created, skill-creator output)
 *   - extra: additional paths from config
 */
export default (opts: SkillsExtOptions = {}) =>
  defineExtension({
    name: 'skills',
    enforce: 'normal',

    apply: (ctx) => {
      const contractBus = asContractBus(ctx.bus)
      const skills = new Map<string, SkillDescriptor>()

      // All paths passed via opts — no getSettingsSync() in apply (settings load is async)
      const builtinDir = opts.builtinDir ?? ctx.paths.skills.builtin
      const agentDir = ctx.paths.skills.agent
      const extraPaths = opts.extraPaths ?? []

      function fromSkillInfo(info: SkillInfo): SkillDescriptor {
        const scope = loader.scopeForPath(info.filePath)
        return createSkillDescriptor({
          id: `skill-${info.name}`,
          name: info.name,
          description: info.description,
          scope,
          parameters: (info.metadata?.parameters as Record<string, unknown>) ?? undefined,
        })
      }

      const loader = new SkillLoader({
        builtinDir,
        agentDir,
        extraPaths,
        logger: ctx.logger,
      })

      // resolveTools: convert skill descriptors to tool descriptors
      const resolveTools: HookHandler = async (...args: unknown[]) => {
        const toolDescriptors = args[0] as Array<{
          name: string; description: string; parameters: Record<string, unknown>
        }>
        const skillTools = [...skills.values()].map((s) => ({
          name: s.name,
          description: s.description,
          parameters: s.parameters ?? { type: 'object', properties: {} },
        }))
        return [...toolDescriptors, ...skillTools]
      }

      return {
        provide: {
          registry: () => ({
            list: (scope?: string) =>
              [...skills.values()].filter((s) => !scope || s.scope === scope),
            get: (name: string) => skills.get(name),
            register: (skill: SkillDescriptor) => {
              skills.set(skill.name, skill)
            },
          }),
        },

        hooks: {
          kernelReady: {
            enforce: 'normal',
            fn: async () => {
              try {
                const loaded = await loader.loadAllSkills()
                for (const info of loaded) {
                  skills.set(info.name, fromSkillInfo(info))
                }
                ctx.logger.info('skills', `${loaded.length} loaded from builtin+agent, ${skills.size} total`)
              } catch (err: unknown) {
                ctx.logger.warn('skills', `Failed to load skills: ${String(err)}`)
              }
            },
          },
          resolveTools: {
            enforce: 'normal',
            fn: resolveTools,
          },
        },

        rpc: {
          'skills.list': () => ({ skills: [...skills.values()] }),
          'skills.reload': async () => {
            try {
              const before = skills.size
              loader.clearCache()
              const loaded = await loader.loadAllSkills()
              for (const info of loaded) {
                skills.set(info.name, fromSkillInfo(info))
              }
              const added = skills.size - before
              contractBus.emit(createEvent('skills.reloaded', { added, removed: 0, updated: 0 }))
              return { added, removed: 0, updated: 0 }
            } catch {
              return { added: 0, removed: 0, updated: 0 }
            }
          },
        },

        dispose: () => skills.clear(),
      }
    },
  })
