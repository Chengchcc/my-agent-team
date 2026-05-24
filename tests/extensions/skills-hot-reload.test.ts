import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createTestKernel } from '../helpers/kernel-helper'
import traceExt from '../../src/extensions/trace'
import sessionExt from '../../src/extensions/session'
import skillsExt from '../../src/extensions/skills'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

interface SkillListResult {
  skills: Array<{ name: string; description: string; scope: string }>
}

/**
 * DESIGN.md gap #9: skills.reload RPC reflected in next skills.list.
 *
 * Skills are directory-structured: <agentDir>/skills/<name>/SKILL.md
 * The skills extension reads from ctx.paths.skills.agent = <agentDir>/skills/
 */

describe('skills hot reload', () => {
  let agentDir: string
  let agentSkillsDir: string

  beforeAll(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'skills-hr-'))
    agentSkillsDir = join(agentDir, 'skills')
    mkdirSync(agentSkillsDir, { recursive: true })

    // Create an initial skill as a directory with SKILL.md
    const skillDir = join(agentSkillsDir, 'initial-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), `---
name: initial-skill
description: Initial skill for hot reload testing
---

# Initial Skill

Some content.
`)
  })

  afterAll(() => {
    rmSync(agentDir, { recursive: true, force: true })
  })

  it('skills.list reflects skills loaded at kernelReady', async () => {
    const k = createTestKernel({
      agentDir,
      extensions: [
        traceExt(),
        sessionExt(),
        skillsExt({
          builtinDir: join(import.meta.dirname, '../../skills'),
        }),
      ],
    })
    await k.start()

    const listR = await k.ctx.rpc.resolve('skills.list')!({}) as SkillListResult
    expect(listR.skills.some(s => s.name === 'initial-skill')).toBe(true)

    await k.stop()
  })

  it('skills.reload picks up newly added skill directory', async () => {
    const k = createTestKernel({
      agentDir,
      extensions: [
        traceExt(),
        sessionExt(),
        skillsExt({
          builtinDir: join(import.meta.dirname, '../../skills'),
        }),
      ],
    })
    await k.start()

    const before = await k.ctx.rpc.resolve('skills.list')!({}) as SkillListResult
    expect(before.skills.some(s => s.name === 'initial-skill')).toBe(true)
    expect(before.skills.some(s => s.name === 'reloaded-skill')).toBe(false)

    // Write a new skill while kernel is running
    const newSkillDir = join(agentSkillsDir, 'reloaded-skill')
    mkdirSync(newSkillDir, { recursive: true })
    writeFileSync(join(newSkillDir, 'SKILL.md'), `---
name: reloaded-skill
description: Added after kernel start
---

# Reloaded Skill
`)

    const reloadR = await k.ctx.rpc.resolve('skills.reload')!({}) as { added: number; removed: number; updated: number }
    expect(reloadR.added).toBe(1)

    const after = await k.ctx.rpc.resolve('skills.list')!({}) as SkillListResult
    expect(after.skills.some(s => s.name === 'reloaded-skill')).toBe(true)

    await k.stop()
  })

  it('skills.reload with no changes returns added=0', async () => {
    const k = createTestKernel({
      agentDir,
      extensions: [
        traceExt(),
        sessionExt(),
        skillsExt({
          builtinDir: join(import.meta.dirname, '../../skills'),
        }),
      ],
    })
    await k.start()

    const r1 = await k.ctx.rpc.resolve('skills.reload')!({}) as { added: number }
    expect(r1).toBeDefined()

    const r2 = await k.ctx.rpc.resolve('skills.reload')!({}) as { added: number }
    expect(r2.added).toBe(0)

    await k.stop()
  })
})
