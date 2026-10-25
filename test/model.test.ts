import { describe, expect, test } from 'bun:test'
import type { RunState } from '../src/run.ts'
import type { RunEvent } from '../src/run.ts'
import type { Snapshot } from '../src/resources.ts'
import { activity, attention, describeEvent, duration, filterRuns, footer, groupRows, header, layout, lastMessage, match, resourceBars, rows, tokens } from '../src/tui/model.ts'

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
    expect(soon).toMatchObject({ when: 'defaults in 12m', detail: 'Guard the walk. · 1 open question' })
    expect(held!.detail).toBe('Decides whether behaviour changes: Guard the walk. · 1 open question')
    expect(blocked).toMatchObject({ label: 'Blocked', detail: 'no access to the tenant', key: 'm', action: 'message' })
    expect(ship).toMatchObject({ label: 'Ready to ship', key: 'S', action: 'ship' })
  })
  test('a deadline already passed says the defaults are being taken', () => {
    expect(attention([run('x', plan(false, NOW - 60_000))], NOW)[0]!.when).toBe('defaults now')
  })
})

describe('rows: the runs table', () => {
  test('stage track: done stages, the current one by status, the rest to come', () => {
    expect(rows([run('a', { stage: 'verify', status: 'running' })], NOW)[0]!.track).toBe('●─●─●─◎╌◌╌◌')
    expect(rows([run('a', { stage: 'plan', status: 'needs-you' })], NOW)[0]!.track).toBe('●─◆╌◌╌◌╌◌╌◌')
    expect(rows([run('a', { stage: 'build', status: 'blocked' })], NOW)[0]!.track).toBe('●─●─✕╌◌╌◌╌◌')
    expect(rows([run('a', { stage: 'done', status: 'done' })], NOW)[0]!.track).toBe('●─●─●─●─●─●')
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

const ev = (run: string, at: number, body: Record<string, unknown>, actor: RunEvent['actor'] = 'engine') => ({ seq: at, at, run, actor, ...body }) as RunEvent

describe('filter, sort and group the runs table', () => {
  const runs = [
    run('fso-1', { title: 'Fix asset list crash', stage: 'verify', createdAt: min(30), tokens: 900 }),
    run('spk-2', { project: 'spk', title: 'Add export endpoint', stage: 'build', createdAt: min(10), tokens: 5000 }),
    run('fso-3', { title: 'Update release branch', stage: 'build', status: 'failed', needs: { kind: 'setup', ask: 'x' }, createdAt: min(20) }),
  ]
  test('field filters (project, status, stage) and any text, together', () => {
    expect(filterRuns(runs, 'project:fso').map(r => r.id)).toEqual(['fso-1', 'fso-3'])
    expect(filterRuns(runs, 'status:failed').map(r => r.id)).toEqual(['fso-3'])
    expect(filterRuns(runs, 'stage:build export').map(r => r.id)).toEqual(['spk-2'])
    expect(filterRuns(runs, 'CRASH').map(r => r.id)).toEqual(['fso-1'])
    expect(filterRuns(runs, '').length).toBe(3)
  })
  test('sort: newest, oldest, latest activity, most tokens', () => {
    expect(rows(runs, NOW, 'newest').map(r => r.run)).toEqual(['spk-2', 'fso-3', 'fso-1'])
    expect(rows(runs, NOW, 'oldest').map(r => r.run)).toEqual(['fso-1', 'fso-3', 'spk-2'])
    expect(rows(runs, NOW, 'tokens').map(r => r.run)).toEqual(['spk-2', 'fso-1', 'fso-3'])
  })
  test('group by stage, in stage order, with counts and tokens; a collapsed group hides its runs', () => {
    const g = groupRows(rows(runs, NOW, 'newest'), runs, new Set(['verify']))
    expect(g.map(x => (x.kind === 'group' ? `${x.collapsed ? '▸' : '▾'}${x.stage} ${x.count} ${x.tokens}` : x.row.run))).toEqual(['▾build 2 5k', 'spk-2', 'fso-3', '▸verify 1 1k'])
    expect(g.find(x => x.kind === 'group' && x.stage === 'verify')).toMatchObject({ collapsed: true })
  })
  test('done runs from before today are hidden unless asked for; the footer says how many', () => {
    const all = [...runs, run('old', { stage: 'done', status: 'done', updatedAt: NOW - 30 * 3_600_000 })]
    expect(filterRuns(all, '').map(r => r.id)).not.toContain('old')
    expect(filterRuns(all, 'status:done').map(r => r.id)).toEqual(['old'])
    expect(footer(all, filterRuns(all, ''), '', NOW)).toBe('3 of 4 runs · 1 done before today hidden')
    expect(footer(all, filterRuns(all, 'project:spk'), 'project:spk', NOW)).toBe('1 of 4 runs match')
  })
})

describe('resources as bars, the activity feed, the message line', () => {
  const snap: Snapshot = { limits: { agents: 2, builds: 2, devices: 4 }, holders: { agents: ['a'], builds: ['a', 'b'], devices: ['c'] }, waiting: [{ run: 'd', kind: 'builds' }] }
  test('one segment per slot, used ones filled; full says so', () => {
    const b = resourceBars(snap)
    expect(b.map(x => `${x.label} ${x.used.map(u => (u ? '█' : '░')).join('')} ${x.text}`)).toEqual(['Agents █░ 1/2 in use', 'Builds ██ 2/2 full', 'Devices █░░░ 1/4 in use'])
    expect(b[1]).toMatchObject({ holders: ['a', 'b'], waiting: ['d'] })
  })
  test('events in words, with the stage they belong to', () => {
    expect(describeEvent(ev('r', 1, { type: 'verify.result', ok: true, newFindings: [] }))).toEqual({ stage: 'verify', text: 'no new findings' })
    expect(describeEvent(ev('r', 1, { type: 'plan.decided', by: 'human', answers: {} }, 'human'))).toEqual({ stage: 'plan', text: 'approved by you' })
    expect(describeEvent(ev('r', 1, { type: 'pr.opened', url: 'u', number: 12 }))).toEqual({ stage: 'ship', text: 'draft PR #12 opened' })
    expect(describeEvent(ev('r', 1, { type: 'run.waiting', resource: 'a build slot' }))).toEqual({ stage: '', text: 'waits for a build slot' })
  })
  test('activity: a run\'s events, newest first, token counts left out', () => {
    const events = [ev('a', min(5), { type: 'setup.done' }), ev('b', min(4), { type: 'setup.done' }), ev('a', min(3), { type: 'tokens.used', tokens: 9 }), ev('a', min(2), { type: 'build.done' }, 'agent')]
    expect(activity(events, 'a').map(x => x.text)).toEqual(['change made', 'worktrees ready'])
    expect(activity(events).length).toBe(3)
  })
  test('the message line: the latest outcome and how long ago', () => {
    const events = [ev('fso-1', min(9), { type: 'pr.opened', url: 'u', number: 7 }), ev('fso-2', min(2), { type: 'setup.done' })]
    expect(lastMessage(events, NOW)).toBe('✓ fso-1 shipped: draft PR #7 · 9m ago')
    expect(lastMessage([ev('x', min(1), { type: 'setup.failed', reason: 'no disk' })], NOW)).toBe('✕ x setup failed: no disk · 1m ago')
    expect(lastMessage([], NOW)).toBe('')
  })
})

describe('layout: the responsive rules', () => {
  test('120 and wider: everything', () => {
    expect(layout(130, 40)).toMatchObject({ tooSmall: false, project: true, tokens: true, track: true, twoLineAttention: true, split: true, message: true, tabNames: true })
  })
  test('80–99: no project or tokens, stage as its label, one-line attention, one Resources line, no message line, tab numbers', () => {
    expect(layout(90, 30)).toMatchObject({ tooSmall: false, project: false, tokens: false, track: false, twoLineAttention: false, split: false, message: false, tabNames: false })
  })
  test('under 80×24: a message instead of a broken layout', () => {
    expect(layout(72, 20)).toMatchObject({ tooSmall: true, text: 'Flow needs at least 80×24 (now 72×20)' })
    expect(layout(100, 23).tooSmall).toBe(true)
  })
  test('rows for the table: what is left after the fixed parts; short terminals drop the bottom panes', () => {
    expect(layout(120, 35).tableRows).toBeGreaterThan(5)
    expect(layout(120, 26).bottom).toBe(false)
  })
})

describe('the palette\'s matching', () => {
  test('letters in order, any gaps; case does not matter', () => {
    expect(match('shp', 'Ship #204598')).toBe(true)
    expect(match('pd', 'Port to develop')).toBe(true)
    expect(match('xz', 'Ship')).toBe(false)
  })
})

describe('durations past ten hours', () => {
  test('keep their minutes', () => { expect(duration(12 * 3_600_000 + 30 * 60_000)).toBe('12h 30m') })
})

import { suggestBase, suggestPatch } from '../src/tui/form.tsx'
describe('the new-run form\'s suggestions', () => {
  const pairs = ['iwb/cmms', 'iwb/metering', 'iwb/product', 'nordex/cmms']
  test('the patch: the customer named on the ticket, else in its board; the app its area names, or the only one', () => {
    expect(suggestPatch({ customer: 'IWB', board: 'x', area: 'Product App' }, pairs)).toBe('iwb/product')
    expect(suggestPatch({ customer: '', board: 'iwb-osapiens-hub', area: 'CMMS' }, pairs)).toBe('iwb/cmms')
    expect(suggestPatch({ customer: '', board: 'iwb-osapiens-hub' }, pairs)).toBeUndefined() // three apps: you choose
    expect(suggestPatch({ customer: 'Nordex', board: 'x' }, pairs)).toBe('nordex/cmms')
    expect(suggestPatch({ customer: '', board: 'field-service-os' }, pairs)).toBeUndefined()
  })
  test('the base: the newest branch of the ticket\'s release tag', () => {
    expect(suggestBase(['3.18', 'Picking'], ['origin/develop', 'origin/patch/3.20.7', 'origin/patch/3.18.41', 'origin/patch/3.18.39'])).toBe('origin/patch/3.18.41')
    expect(suggestBase(['Picking'], ['origin/develop'])).toBeUndefined()
  })
})

describe('the patch\'s app from the ticket', () => {
  test('a board naming the customer and a title naming the area: picking → product', () => {
    const pairs = ['iwb/cmms', 'iwb/metering', 'iwb/product']
    const apps = { cmms: 'cmms|maintenance', product: 'product|picking|material', metering: 'meter' }
    expect(suggestPatch({ customer: '', board: 'iwb-osapiens-hub', title: 'Picking – Remaining Required Quantity' }, pairs, apps)).toBe('iwb/product')
    expect(suggestPatch({ customer: '', board: 'iwb-osapiens-hub', title: 'Login fails' }, pairs, apps)).toBeUndefined()
  })
})
