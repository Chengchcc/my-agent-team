import path from 'node:path'
import { defineExtension } from '../../kernel/define-extension'
import type { HookHandler } from '../../kernel/define-extension'
import { asContractBus } from '../../application/event-bus/contract-bus'
import { createSkillDescriptor } from '../../domain/skill-descriptor'
import type { SkillDescriptor } from '../../domain/skill-descriptor'
import { SkillLoader } from './loader'
import type { SkillInfo } from './loader'
import type { SlashCommand } from '../../application/slash'
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
function createSkillHooks(deps: {
  skills: Map<string, SkillDescriptor>
  loader: SkillLoader
}): {
  resolveTools: HookHandler
  onToolCall: HookHandler
  transformPrompt: HookHandler
} {
  const { skills, loader } = deps

  const resolveTools: HookHandler = async (...args: unknown[]) => {
    const toolDescriptors = args[0] as Array<{
      name: string; description: string; parameters: Record<string, unknown>
    }>
    if (skills.size === 0) return toolDescriptors

    const skillTool = {
      name: 'Skill',
      description: "Load a skill's full instructions into context. Call when a user request matches a skill from the catalog in the system prompt.",
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            enum: [...skills.keys()].sort(),
          },
        },
        required: ['name'],
      },
    }
    return [...toolDescriptors, skillTool]
  }

  const onToolCall: HookHandler = async (...args: unknown[]) => {
    const call = args[0] as { name: string; arguments: Record<string, unknown>; result?: unknown }
    if (call.name !== 'Skill') return call
    if (call.result !== undefined) return call

    const skillName = call.arguments?.name as string | undefined
    if (!skillName) {
      return { ...call, result: { content: 'Missing required argument: name', isError: true } }
    }
    const info = await loader.loadSkill(skillName)
    if (!info) {
      return { ...call, result: { content: `Skill not found: ${skillName}`, isError: true } }
    }
    const skillDir = path.dirname(info.filePath)
    const body = `# Skill: ${info.name}\n\nSkill directory (use Read/Bash for references): ${skillDir}\n\n---\n\n${info.content}`
    return { ...call, result: { content: body, isError: false } }
  }

  const transformPrompt: HookHandler = async (...args: unknown[]) => {
    const prompt = args[0] as { system: string; messages: Array<{ role: string; content: string }> }
    if (skills.size === 0) return prompt

    const lines = ['## Available Skills', '',
      "The following skills are available via the `Skill` tool. Call `Skill(name='<name>')` to load full instructions.",
      '']
    for (const s of [...skills.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`- **${s.name}**: ${s.description}`)
    }
    return { ...prompt, system: `${prompt.system}\n\n${lines.join('\n')}` }
  }

  return { resolveTools, onToolCall, transformPrompt }
}

export default (opts: SkillsExtOptions = {}) =>
  defineExtension({
    name: 'skills',
    enforce: 'normal',

    apply: (ctx) => {
      const contractBus = asContractBus(ctx.bus)
      const skills = new Map<string, SkillDescriptor>()

      // All paths passed via opts — no getSettingsSync() in apply (settings load is async)
      const builtinDir = opts.builtinDir ?? ctx.paths.skills.builtin
      const agentDir = opts.agentDir ?? ctx.paths.skills.agent
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

      // ── Slash commands (mutable array for hot-reload) ──
      const slashCommands: SlashCommand[] = []

      function buildSlashCommands(): SlashCommand[] {
        return [...skills.values()].map((s): SlashCommand => ({
          name: s.name,
          description: s.description,
          source: 'skill',
          resolve: async (input: string) => ({ kind: 'submit-prompt', text: input }),
        }))
      }

      function refreshSlash(): void {
        slashCommands.length = 0
        slashCommands.push(...buildSlashCommands())
      }

      // ── Reload ──
      const doReload = async () => {
        try {
          const before = skills.size
          loader.clearCache()
          const loaded = await loader.loadAllSkills()
          for (const info of loaded) {
            skills.set(info.name, fromSkillInfo(info))
          }
          const added = skills.size - before
          refreshSlash()
          void contractBus.emit('skills.reloaded', { added, removed: 0, updated: 0 })
          return { added, removed: 0, updated: 0 }
        } catch {
          return { added: 0, removed: 0, updated: 0 }
        }
      }

      const hooks = createSkillHooks({ skills, loader })

      return {
        provide: {
          'skills.registry': () => ({
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
                refreshSlash()
              } catch (err: unknown) {
                ctx.logger.warn('skills', `Failed to load skills: ${String(err)}`)
              }
            },
          },
          resolveTools: { enforce: 'normal', fn: hooks.resolveTools },
          onToolCall: { enforce: 'pre', fn: hooks.onToolCall },
          transformPrompt: { enforce: 'normal', order: 900, fn: hooks.transformPrompt },
        },

        rpc: {
          'skills.list': () => ({ skills: [...skills.values()] }),
          'skills.reload': async () => doReload(),
        },

        slash: slashCommands,

        subscribe: {
          'skills.reload-requested': async () => {
            try { await doReload() } catch (e) { ctx.logger.warn('skills', `reload-requested failed: ${String(e)}`) }
          },
        },

        dispose: () => skills.clear(),
      }
    },
  })
