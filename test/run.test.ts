import { describe, expect, test } from 'bun:test'
import { apply, fold, TransitionError, type EventBody, type RunEvent } from '../src/run.ts'

// A run's state is a fold over its events: every transition is an event with who caused it, so history,
// the "decided without you" ledger and the timeline come from the log.
let seq = 0
const T0 = Date.parse('2026-10-24T12:00:00Z')
const ev = (e: EventBody & { actor?: RunEvent['actor'] }, min = seq): RunEvent =>
  ({ seq: ++seq, at: T0 + min * 60_000, run: 'r1', actor: 'engine', ...e } as RunEvent)
const created = () => ev({ type: 'run.created', ticket: '#186278', title: 'Fix asset list memory crash', project: 'example', base: 'origin/develop' })
const toBuild = (): RunEvent[] => [created(), ev({ type: 'setup.done' }), ev({ type: 'plan.submitted', summary: 'p', questions: [] }, 5)]

describe('a run from ticket to draft PR', () => {
  test('happy path: setup → plan (no questions, so no wait) → build → verify → review → draft PR → done', () => {
    let s = fold([...toBuild(), ev({ type: 'build.done' }), ev({ type: 'verify.result', ok: true, newFindings: [] }), ev({ type: 'review.result', findings: 0 })])
    expect(s).toMatchObject({ stage: 'ship', status: 'needs-you', needs: { kind: 'ship' } })
    s = apply(s, ev({ type: 'pr.opened', actor: 'human', url: 'https://x/pr/1', number: 1 }))
    expect(s).toMatchObject({ stage: 'ship', status: 'needs-you', needs: { kind: 'pr' }, pr: { number: 1 } })
    expect(apply(s, ev({ type: 'run.done', actor: 'human' }))).toMatchObject({ stage: 'done', status: 'done' })
  })
})

describe('without a reviewer', () => {
  test('review skipped (with the reason): verified runs wait for the human to ship', () => {
    let s = fold([...toBuild(), ev({ type: 'build.done' }), ev({ type: 'verify.result', ok: true, newFindings: [] })])
    s = apply(s, ev({ type: 'review.skipped', reason: 'no reviewer configured' }))
    expect(s).toMatchObject({ stage: 'ship', status: 'needs-you', needs: { kind: 'ship', ask: expect.stringMatching(/flow ship/) } })
  })
})

describe('the plan gate', () => {
  const q = (id: string, held = false) => ({ id, text: `${id}?`, default: 'yes', held })
  const planned = (qs: ReturnType<typeof q>[], deadline?: number) => fold([created(), ev({ type: 'setup.done' }), ev({ type: 'plan.submitted', summary: 'p', questions: qs, ...(deadline ? { deadline } : {}) })])
  test('open questions: waits for the human, with the deadline the engine set', () => {
    const s = planned([q('Q1'), q('Q2')], T0 + 30 * 60_000)
    expect(s).toMatchObject({ stage: 'plan', status: 'needs-you', needs: { kind: 'plan', held: false, deadline: T0 + 30 * 60_000 } })
  })
  test('the human answers: build starts, the answers are kept', () => {
    const s = apply(planned([q('Q1')], T0 + 1), ev({ type: 'plan.decided', by: 'human', actor: 'human', answers: { Q1: 'no' } }))
    expect(s).toMatchObject({ stage: 'build', status: 'running', plan: { answers: { Q1: 'no' }, decidedBy: 'human' } })
    expect(s.needs).toBeUndefined()
  })
  test('a held question (it decides whether behaviour changes) never goes by deadline', () => {
    const s = planned([q('Q1'), q('Q2', true)])
    expect(s.needs).toMatchObject({ kind: 'plan', held: true })
    expect(s.needs?.deadline).toBeUndefined()
    expect(() => apply(s, ev({ type: 'plan.decided', by: 'deadline', answers: {} }))).toThrow(TransitionError)
  })
  test('deciding a plan that isn\'t waiting is refused', () => {
    expect(() => apply(fold(toBuild()), ev({ type: 'plan.decided', by: 'human', answers: {} }))).toThrow(/no plan is waiting/)
  })
})

describe('loops and stop rules', () => {
  const built = () => apply(fold(toBuild()), ev({ type: 'build.done' }))
  test('verify red: back to build, counted; the third red in a row stops for the human', () => {
    let s = apply(built(), ev({ type: 'verify.result', ok: false, newFindings: ['a.ts|TS2322'] }))
    expect(s).toMatchObject({ stage: 'build', status: 'running', loops: { verify: 1 } })
    s = apply(apply(s, ev({ type: 'build.done' })), ev({ type: 'verify.result', ok: false, newFindings: ['x'] }))
    s = apply(apply(s, ev({ type: 'build.done' })), ev({ type: 'verify.result', ok: false, newFindings: ['x'] }))
    expect(s).toMatchObject({ stage: 'verify', status: 'needs-you', needs: { kind: 'verify' }, loops: { verify: 3 } })
  })
  test('a green verify resets the red streak', () => {
    let s = apply(built(), ev({ type: 'verify.result', ok: false, newFindings: ['x'] }))
    s = apply(apply(s, ev({ type: 'build.done' })), ev({ type: 'verify.result', ok: true, newFindings: [] }))
    expect(s).toMatchObject({ stage: 'review', loops: { verify: 0, verifyRuns: 2 } })
  })
  test('review findings: back to build; the review cap stops for the human instead of another run', () => {
    let s = apply(built(), ev({ type: 'verify.result', ok: true, newFindings: [] }))
    for (let i = 0; i < 3; i++) {
      s = apply(s, ev({ type: 'review.result', findings: 2 }))
      if (s.status === 'needs-you') break
      s = apply(apply(s, ev({ type: 'build.done' })), ev({ type: 'verify.result', ok: true, newFindings: [] }))
    }
    expect(s).toMatchObject({ status: 'needs-you', needs: { kind: 'review' }, loops: { review: 3 } })
  })
  test('steps out of order are refused (verify before anything was built)', () => {
    expect(() => apply(fold([created(), ev({ type: 'setup.done' })]), ev({ type: 'verify.result', ok: true, newFindings: [] }))).toThrow(TransitionError)
  })
})

describe('waiting, pausing, asking, blocking', () => {
  test('paused for the plan\'s usage limit, then resumed: the stage is kept', () => {
    let s = apply(fold(toBuild()), ev({ type: 'run.paused', window: 'fiveHour', until: T0 + 3 * 3600_000 }))
    expect(s).toMatchObject({ stage: 'build', status: 'paused', pausedUntil: T0 + 3 * 3600_000 })
    s = apply(s, ev({ type: 'run.resumed' }))
    expect(s).toMatchObject({ stage: 'build', status: 'running' })
    expect(s.pausedUntil).toBeUndefined()
  })
  test('waiting for a resource names it', () => {
    expect(apply(fold(toBuild()), ev({ type: 'run.waiting', resource: 'ios-sim' }))).toMatchObject({ status: 'waiting', waitingFor: 'ios-sim' })
  })
  test('the agent asks: needs you with the question; your message sends it on', () => {
    let s = apply(fold(toBuild()), ev({ type: 'agent.asked', actor: 'agent', question: 'Should soft-deleted users appear?' }))
    expect(s).toMatchObject({ status: 'needs-you', needs: { kind: 'question', ask: 'Should soft-deleted users appear?' } })
    s = apply(s, ev({ type: 'human.message', actor: 'human', text: 'No' }))
    expect(s.status).toBe('running')
  })
  test('blocked: the agent gave up and says why; a message from you sends it on again', () => {
    let s = apply(fold(toBuild()), ev({ type: 'run.blocked', actor: 'agent', reason: 'no access to the tenant' }))
    expect(s).toMatchObject({ status: 'blocked', needs: { kind: 'blocked', ask: 'no access to the tenant' } })
    expect(apply(s, ev({ type: 'human.message', actor: 'human', text: 'use demo' })).status).toBe('running')
  })
})

describe('session health and usage per run', () => {
  test('tokens add up per turn; compactions are counted; the session id is kept', () => {
    const s = fold([...toBuild(), ev({ type: 'session.started', session: 's-1' }), ev({ type: 'tokens.used', tokens: 120_000 }),
      ev({ type: 'session.compacted', before: 968_000, after: 37_000 }), ev({ type: 'tokens.used', tokens: 80_000 })])
    expect(s).toMatchObject({ session: 's-1', tokens: 200_000, compactions: 1 })
  })
})
