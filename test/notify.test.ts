import { describe, expect, test } from 'bun:test'
import type { RunState } from '../src/run.ts'
import { notice } from '../src/notify.ts'

// When a run starts needing you, a desktop notification says which and what for; nothing for every other change.
const s = (over: Partial<RunState>): RunState => ({ id: 'fso-1', ticket: '#1', title: 'Order history', project: 'fso', base: 'origin/develop', stage: 'build', status: 'running',
  loops: { verify: 0, verifyRuns: 0, review: 0 }, tokens: 0, compactions: 0, createdAt: 0, updatedAt: 0, ...over })
describe('notifications', () => {
  test('a run that now needs you, is blocked or failed: one notice saying what', () => {
    expect(notice(s({}), s({ stage: 'ship', status: 'needs-you', needs: { kind: 'ship', ask: 'verified: publish the draft PR with flow ship' } }))).toEqual({ title: 'flow · #1 Order history', text: 'Ready to ship: verified: publish the draft PR with flow ship' })
    expect(notice(s({}), s({ status: 'blocked', needs: { kind: 'blocked', ask: 'claude exited' } }))?.text).toBe('Blocked: claude exited')
    expect(notice(s({ stage: 'plan' }), s({ stage: 'plan', status: 'needs-you', needs: { kind: 'plan', ask: '2 open questions' } }))?.text).toBe('Plan to approve: 2 open questions')
  })
  test('no notice when nothing new needs you (the same need again, or work going on)', () => {
    const ship = s({ status: 'needs-you', needs: { kind: 'ship', ask: 'x' } })
    expect(notice(ship, { ...ship, tokens: 5 })).toBeNull()
    expect(notice(s({}), s({ stage: 'verify' }))).toBeNull()
    expect(notice(undefined, s({}))).toBeNull()
  })
})
