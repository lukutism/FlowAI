import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FakeAgent } from '../src/agent/fake.ts'
import { Ingest } from '../src/ingest.ts'
import { EventStore } from '../src/store.ts'

// Step 1's milestone: one run from ticket to "draft PR ready", the agent's turns replayed from real subscription
// sessions, and the event log telling the whole story.
const fixture = (n: string) => readFileSync(join(import.meta.dir, 'fixtures', `${n}.jsonl`), 'utf8')

describe('a run from ticket to draft PR, with a fake agent replaying real sessions', () => {
  test('the log shows every step, who did it, the agent\'s session, tokens, the refused push and the compaction', async () => {
    let t = Date.parse('2026-10-24T12:00:00Z')
    const store = new EventStore(':memory:', () => (t += 60_000))
    const ingest = new Ingest(store)
    const agent = new FakeAgent([fixture('01-turn-tool'), fixture('04-stream')])
    const run = '#186278'

    store.append(run, 'human', { type: 'run.created', ticket: run, title: 'Fix asset list memory crash', project: 'example', base: 'origin/develop' })
    store.append(run, 'engine', { type: 'setup.done' })
    for await (const e of agent.turn('plan the fix')) ingest.agent(run, e)
    store.append(run, 'agent', { type: 'plan.submitted', summary: 'clear selector caches on asset change', questions: [] })
    for await (const e of agent.turn('build it')) ingest.agent(run, e)
    store.append(run, 'agent', { type: 'build.done' })
    store.append(run, 'engine', { type: 'verify.result', ok: true, newFindings: [] })
    store.append(run, 'engine', { type: 'review.result', findings: 0 })
    store.append(run, 'human', { type: 'pr.opened', url: 'https://example/pr/7', number: 7 })

    expect(store.state(run)).toMatchObject({ stage: 'ship', status: 'needs-you', needs: { kind: 'pr', ask: 'review draft PR #7' }, compactions: 1, session: expect.any(String) })
    expect(store.state(run)!.tokens).toBeGreaterThan(100_000)
    expect(store.events(run).map(e => `${e.actor}:${e.type}`)).toEqual([
      'human:run.created', 'engine:setup.done',
      'agent:session.started', 'agent:tokens.used',
      'agent:plan.submitted',
      // the second turn: the refused push, then /compact (a turn the CLI reports with zero tokens, so none recorded)
      'agent:session.started', 'agent:tool.denied', 'agent:tokens.used', 'agent:session.compacted',
      'agent:build.done', 'engine:verify.result', 'engine:review.result', 'human:pr.opened',
    ])
    expect(store.events(run).find(e => e.type === 'tool.denied')).toMatchObject({ tool: 'Bash', detail: 'git push origin main' })
  })
  test('plan usage from the stream is kept for the scheduler, not as run history', async () => {
    const store = new EventStore(':memory:')
    const ingest = new Ingest(store)
    store.append('r', 'human', { type: 'run.created', ticket: 'r', title: 't', project: 'example', base: 'b' })
    for await (const e of new FakeAgent([fixture('01-turn-tool')]).turn('x')) ingest.agent('r', e)
    expect(ingest.windows.week).toMatchObject({ utilization: 0.55 })
    expect(store.events('r').some(e => e.type.startsWith('usage'))).toBe(false)
  })
})
