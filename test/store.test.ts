import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore } from '../src/store.ts'
import { TransitionError } from '../src/run.ts'

const created = { type: 'run.created', ticket: 'SPK-212', title: 'Migrate push to FCM v1', project: 'example', base: 'origin/main' } as const
let clock = Date.parse('2026-10-24T12:00:00Z')
const store = (file = ':memory:') => new EventStore(file, () => (clock += 1000))

describe('EventStore: the append-only log every screen and number comes from', () => {
  test('append numbers events in order and stamps the time; state is the fold of the run\'s events', () => {
    const s = store()
    const a = s.append('SPK-212', 'human', created)
    const b = s.append('SPK-212', 'engine', { type: 'setup.done' })
    expect(b.seq).toBe(a.seq + 1)
    expect(b.at).toBeGreaterThan(a.at)
    expect(s.state('SPK-212')).toMatchObject({ ticket: 'SPK-212', stage: 'plan', status: 'running' })
    expect(s.events('SPK-212').map(e => [e.type, e.actor])).toEqual([['run.created', 'human'], ['setup.done', 'engine']])
  })
  test('an event the run can\'t take is refused and never stored', () => {
    const s = store()
    s.append('r', 'human', created)
    expect(() => s.append('r', 'engine', { type: 'build.done' })).toThrow(TransitionError)
    expect(s.events('r')).toHaveLength(1)
  })
  test('the log survives a restart: a new store on the same file has the same runs and states', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'flow-')), 'flow.db')
    const s = store(file)
    s.append('r', 'human', created); s.append('r', 'engine', { type: 'setup.done' })
    s.close()
    const again = store(file)
    expect(again.state('r')).toMatchObject({ stage: 'plan' })
    expect(again.runs().map(r => r.id)).toEqual(['r'])
  })
  test('subscribers get each stored event (the TUI\'s live feed); refused ones never reach them', () => {
    const s = store(), seen: string[] = []
    const off = s.subscribe(e => seen.push(`${e.run}:${e.type}`))
    s.append('r', 'human', created)
    try { s.append('r', 'engine', { type: 'pr.opened', url: 'u', number: 1 }) } catch {}
    off()
    s.append('r', 'engine', { type: 'setup.done' })
    expect(seen).toEqual(['r:run.created'])
  })
  test('runs lists every run\'s current state, newest change first', () => {
    const s = store()
    s.append('a', 'human', { ...created, ticket: 'A' })
    s.append('b', 'human', { ...created, ticket: 'B' })
    s.append('a', 'engine', { type: 'setup.done' })
    expect(s.runs().map(r => r.ticket)).toEqual(['A', 'B'])
  })
  test('events after a sequence number: what a reconnecting screen missed', () => {
    const s = store()
    const first = s.append('r', 'human', created)
    s.append('r', 'engine', { type: 'setup.done' })
    expect(s.since(first.seq).map(e => e.type)).toEqual(['setup.done'])
  })
})

describe('recent', () => {
  test('the last n events of all runs, oldest first', () => {
    const s = new EventStore(':memory:')
    for (const r of ['a', 'b', 'c']) s.append(r, 'human', { type: 'run.created', ticket: r, title: r, project: 'p', base: 'b' })
    s.append('a', 'engine', { type: 'setup.done' })
    expect(s.recent(2).map(e => `${e.run}:${e.type}`)).toEqual(['c:run.created', 'a:setup.done'])
  })
})

describe('EventStore: a log with an impossible history still opens', () => {
  test('an event the state cannot take (a second writer appended it) is skipped and reported, not fatal', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'flow-')), 'flow.db')
    const s = store(file)
    s.append('r', 'human', created); s.append('r', 'engine', { type: 'setup.done' })
    s.close()
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
    const db = new Database(file)
    db.run("INSERT INTO events (at, run, actor, type, body) VALUES (1, 'r', 'human', 'plan.decided', '{\"type\":\"plan.decided\",\"by\":\"human\",\"answers\":{}}')")
    db.close()
    const skipped: string[] = []
    const again = new EventStore(file, Date.now, m => skipped.push(m))
    expect(again.state('r')).toMatchObject({ stage: 'plan' })
    expect(skipped[0]).toMatch(/plan\.decided.*r.*no plan is waiting/)
  })
})
