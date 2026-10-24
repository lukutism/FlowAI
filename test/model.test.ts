import { describe, expect, test } from 'bun:test'
import type { RunState } from '../src/run.ts'
import { attention, duration, header, rows, tokens } from '../src/tui/model.ts'

// What the Runs screen shows, from run states: computed without a terminal.
const NOW = Date.parse('2026-10-25T12:00:00Z')
const min = (m: number) => NOW - m * 60_000
const run = (id: string, over: Partial<RunState>): RunState => ({
  id, ticket: `#${id}`, title: `Title ${id}`, project: 'fso', base: 'origin/develop', stage: 'build', status: 'running',
  loops: { verify: 0, verifyRuns: 0, review: 0 }, tokens: 0, compactions: 0, createdAt: min(30), updatedAt: min(1), ...over,
})
const plan = (held: boolean, deadline?: number): Partial<RunState> => ({ stage: 'plan', status: 'needs-you',
  needs: { kind: 'plan', ask: '1 open question', held, ...(deadline ? { deadline } : {}) },
  plan: { summary: 'Guard the walk.', questions: [{ id: 'Q1', text: 'Also the order list?', default: 'no', held }] } })

describe('attention: what needs you, held first, then by deadline', () => {
  const runs = [
    run('ship', { stage: 'ship', status: 'needs-you', needs: { kind: 'ship', ask: 'verified' } }),
    run('late', plan(false, NOW + 40 * 60_000)),
    run('blocked', { status: 'blocked', needs: { kind: 'blocked', ask: 'no access to the tenant' } }),
    run('soon', plan(false, NOW + 12 * 60_000)),
    run('held', plan(true)),
    run('busy', {}),
  ]
  test('order: held plan, plans by deadline, blocked, ready to ship; running runs are not listed', () => {
    expect(attention(runs, NOW).map(a => a.run)).toEqual(['held', 'soon', 'late', 'blocked', 'ship'])
  })
  test('each says what is asked, what happens if nobody answers, and the key that acts', () => {
    const [held, soon, , blocked, ship] = attention(runs, NOW)
    expect(held).toMatchObject({ label: 'Plan approval', when: 'held for you', key: 'a', action: 'approve' })
    expect(soon).toMatchObject({ when: 'defaults in 12m', detail: 'Q1 Also the order list? (default: no)' })
    expect(blocked).toMatchObject({ label: 'Blocked', detail: 'no access to the tenant', key: 'm', action: 'message' })
    expect(ship).toMatchObject({ label: 'Ready to ship', key: 's', action: 'ship' })
  })
  test('a deadline already passed says the defaults are being taken', () => {
    expect(attention([run('x', plan(false, NOW - 60_000))], NOW)[0]!.when).toBe('defaults now')
  })
})

describe('rows: the runs table', () => {
  test('stage track: done stages, the current one by status, the rest to come', () => {
    expect(rows([run('a', { stage: 'verify', status: 'running' })], NOW)[0]!.track).toBe('●●●◎◌◌')
    expect(rows([run('a', { stage: 'plan', status: 'needs-you' })], NOW)[0]!.track).toBe('●◆◌◌◌◌')
    expect(rows([run('a', { stage: 'build', status: 'blocked' })], NOW)[0]!.track).toBe('●●✕◌◌◌')
    expect(rows([run('a', { stage: 'done', status: 'done' })], NOW)[0]!.track).toBe('●●●●●●')
  })
  test('status word with loop counts; paused says until when; tokens and elapsed time', () => {
    const [r1, r2, r3] = rows([
      run('a', { stage: 'build', loops: { verify: 2, verifyRuns: 2, review: 0 }, tokens: 1_234_000 }),
      run('b', { status: 'paused', pausedUntil: Date.parse('2026-10-25T14:00:00Z') }),
      run('c', { stage: 'review', loops: { verify: 0, verifyRuns: 1, review: 2 } }),
    ], NOW)
    expect(r1).toMatchObject({ status: 'fixing · verify ×2', tokens: '1.2M', elapsed: '30m' })
    expect(r2!.status).toMatch(/^paused until \d\d:00$/)
    expect(r3!.status).toBe('running · review ×2')
  })
  test('next: your step in words, or what the run does next', () => {
    const next = (o: Partial<RunState>) => rows([run('a', o)], NOW)[0]!.next
    expect(next(plan(true))).toBe('approve plan')
    expect(next({ stage: 'ship', status: 'needs-you', needs: { kind: 'ship', ask: '' } })).toBe('ship')
    expect(next({ stage: 'ship', status: 'needs-you', needs: { kind: 'pr', ask: '' }, pr: { number: 4711, url: 'u' } })).toBe('review PR #4711')
    expect(next({ stage: 'verify' })).toBe('verifying')
    expect(next({ status: 'waiting', waitingFor: 'ios-sim' })).toBe('waits for ios-sim')
  })
  test('done runs go below the others, newest first', () => {
    const r = rows([run('old', { stage: 'done', status: 'done', updatedAt: min(50) }), run('live', {}), run('new', { stage: 'done', status: 'done', updatedAt: min(5) })], NOW)
    expect(r.map(x => x.run)).toEqual(['live', 'new', 'old'])
  })
})

describe('the line a run targets', () => {
  test('a release fix and its port are told apart by their line', () => {
    const r = rows([run('a', { base: 'origin/patch/3.18.41' }), run('b', { base: 'origin/develop' })], NOW)
    expect(r.map(x => x.line)).toEqual(['3.18.41', 'develop'])
    expect(attention([run('c', { base: 'origin/release/3.21', ...plan(true) })], NOW)[0]!.line).toBe('3.21')
  })
})

describe('header and formats', () => {
  test('counts and plan windows', () => {
    const h = header([run('a', {}), run('b', plan(true)), run('c', { status: 'paused' }), run('d', { stage: 'done', status: 'done' })], {
      fiveHour: { utilization: 0.07, resetsAt: Date.parse('2026-10-25T14:00:00Z') / 1000, status: 'allowed' },
      week: { utilization: 0.55, resetsAt: Date.parse('2026-10-27T08:00:00Z') / 1000, status: 'allowed' },
    }, NOW)
    expect(h).toMatchObject({ active: 3, needYou: 1, waiting: 1, fiveHour: '7%', week: '55%' })
  })
  test('durations and token counts', () => {
    expect([duration(45_000), duration(14 * 60_000), duration(220 * 60_000)]).toEqual(['<1m', '14m', '3h 40m'])
    expect([tokens(0), tokens(93_400), tokens(1_150_000)]).toEqual(['–', '93k', '1.2M'])
  })
})
