import { describe, test, expect } from 'bun:test'
import { _enqueuePermissionRequest, _respondPermissionForTest } from '../../src/extensions/frontend.tui/overlays/impls/overlay-permission/use-permission-manager'
import { _enqueueAskUserQuestion, _respondAskUserQuestionForTest } from '../../src/extensions/frontend.tui/overlays/impls/overlay-ask-user-question/use-ask-user-question-manager'

describe('overlay permission', () => {
  test('respond resolves the promise', async () => {
    const p = _enqueuePermissionRequest({ toolName: 't', reason: 'r' })
    _respondPermissionForTest('allow')
    expect(await p).toBe('allow')
  })

  test('dismiss resolves deny (via respond)', async () => {
    const p = _enqueuePermissionRequest({ toolName: 't', reason: 'r' })
    _respondPermissionForTest('deny')
    expect(await p).toBe('deny')
  })
})

describe('overlay ask-user-question', () => {
  test('respond resolves the promise', async () => {
    const p = _enqueueAskUserQuestion({ questions: [{ question: 'q', header: 'h', options: [], multi_select: false }] })
    const result: { cancelled: true } = { cancelled: true }
    _respondAskUserQuestionForTest(result)
    expect(await p).toEqual(result)
  })

  test('dismiss cancels', async () => {
    const p = _enqueueAskUserQuestion({ questions: [{ question: 'q', header: 'h', options: [], multi_select: false }] })
    _respondAskUserQuestionForTest({ cancelled: true })
    const r = await p
    expect('cancelled' in r && r.cancelled).toBe(true)
  })
})
