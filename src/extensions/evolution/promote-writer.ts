import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProposalRecord } from '../../domain/evolution-proposal'

function renderSkillMd(p: NonNullable<ProposalRecord['skillProposed']>): string {
  return [
    '---',
    `name: ${p.name}`,
    `description: ${p.description}`,
    `trigger: ${p.trigger}`,
    '---',
    '',
    p.instructions,
    '',
  ].join('\n')
}

export function promoteToSkill(opts: {
  proposal: ProposalRecord
  skillsDir: string
}): { filePath: string } {
  const p = opts.proposal.skillProposed
  if (!p) throw new Error('proposal has no skillProposed payload')
  const safeName = p.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  const dir = join(opts.skillsDir, safeName)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'SKILL.md')
  const md = renderSkillMd(p)
  writeFileSync(filePath, md, 'utf8')
  return { filePath }
}
