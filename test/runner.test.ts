import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FakeAgent } from '../src/agent/fake.ts'
import { Runner } from '../src/runner.ts'
import { EventStore } from '../src/store.ts'

const fixture = (n: string) => readFileSync(join(import.meta.dir, 'fixtures', `${n}.jsonl`), 'utf8')
const apiKeySession = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-api', model: 'm', apiKeySource: 'ANTHROPIC_API_KEY' }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1, session_id: 's-api', usage: { input_tokens: 10, output_tokens: 10 } }),
].join('\n')

function setup(scripts: string[], windows?: object) {
  let now = Date.parse('2026-10-24T14:00:00Z')
  const store = new EventStore(':memory:', () => now)
  const agent = new FakeAgent(scripts)
  let closed = 0
  const runner = new Runner({ store, maxParallel: 2, limits: { fiveHour: 0.9, week: 0.95 }, agentFor: () => Object.assign(agent, { close: async () => { closed++ } }), now: () => now, sleep: async ms => { now += ms } })
  if (windows) runner.ingest.windows = windows as never
  store.append('r', 'human', { type: 'run.created', ticket: 'r', title: 't', project: 'example', base: 'origin/develop' })
  store.append('r', 'engine', { type: 'setup.done' })
  return { runner, store, agent, closed: () => closed }
}

describe('Runner.turn: one agent turn for a run, recorded', () => {
  test('returns the agent\'s answer; the session and tokens land in the run\'s log', async () => {
    const { runner, store } = setup([fixture('01-turn-tool')])
    expect(await runner.turn('r', 'plan the fix')).toEqual({ ok: true, text: '1' })
    expect(store.events('r').map(e => e.type)).toEqual(['run.created', 'setup.done', 'session.started', 'tokens.used'])
  })
  test('the plan windows are full: the run is paused until the reset, resumes, then the turn runs', async () => {
    const full = { fiveHour: { utilization: 0.97, resetsAt: Date.parse('2026-10-24T17:00:00Z') / 1000, status: 'allowed' } }
    const { runner, store } = setup([fixture('01-turn-tool')], full)
    await runner.turn('r', 'x')
    const log = store.events('r')
    expect(log.map(e => e.type).slice(2, 5)).toEqual(['run.paused', 'run.resumed', 'session.started'])
    expect(log.find(e => e.type === 'run.paused')).toMatchObject({ window: 'fiveHour', until: Date.parse('2026-10-24T17:00:00Z') })
  })
  test('a session that is not on the subscription is stopped before it does anything: the run is blocked, the process closed', async () => {
    const { runner, store, closed } = setup([apiKeySession])
    expect(await runner.turn('r', 'x')).toMatchObject({ ok: false })
    expect(store.state('r')).toMatchObject({ status: 'blocked', needs: { ask: expect.stringMatching(/not on your Claude subscription/) } })
    expect(store.events('r').some(e => e.type === 'tokens.used')).toBe(false)
    expect(closed()).toBe(1)
  })
  test('the agent process failing is recorded as blocked with its error, not lost', async () => {
    const { runner, store } = setup([])
    expect(await runner.turn('r', 'x')).toMatchObject({ ok: false })
    expect(store.state('r')).toMatchObject({ status: 'blocked', needs: { ask: expect.stringMatching(/agent stopped: .*recorded turn/) } })
  })
  test('plan windows reported by a turn are handed out for saving, and saved ones are used by the next process', async () => {
    let saved: unknown
    const store = new EventStore(':memory:')
    store.append('r', 'human', { type: 'run.created', ticket: 'r', title: 't', project: 'example', base: 'b' })
    const r1 = new Runner({ store, maxParallel: 1, limits: { fiveHour: 0.9, week: 0.95 }, agentFor: () => new FakeAgent([fixture('01-turn-tool')]), onWindows: w => { saved = w } })
    await r1.turn('r', 'x')
    expect(saved).toMatchObject({ week: { utilization: 0.55 } })
    const r2 = new Runner({ store, maxParallel: 1, limits: { fiveHour: 0.9, week: 0.95 }, agentFor: () => new FakeAgent([]), windows: saved as never })
    expect(r2.ingest.windows.week?.utilization).toBe(0.55)
  })
})
