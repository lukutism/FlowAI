import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FlowClient } from '../src/client.ts'
import { serve } from '../src/server.ts'
import type { Command, Reply } from '../src/service.ts'
import { EventStore } from '../src/store.ts'
import type { Windows } from '../src/usage.ts'

// The screen and the CLI talk to the background service over a local WebSocket with a token only the user can
// read (a web page could otherwise reach ws://localhost and press "ship").
function fakeService() {
  const notice = new Set<(n: { run: string; text: string }) => void>(), wins = new Set<(w: Windows) => void>()
  const sent: Command[] = []
  return {
    sent, emitNotice: (n: { run: string; text: string }) => notice.forEach(f => f(n)), emitWindows: (w: Windows) => wins.forEach(f => f(w)),
    svc: {
      dispatch: (c: Command): Reply => { sent.push(c); return 'run' in c && c.run === 'nope' ? { ok: false, error: 'no run nope' } : { ok: true, run: 'run' in c ? c.run : 'x' } },
      windows: (): Windows => ({ week: { utilization: 0.59, resetsAt: 1, status: 'allowed' } }),
      onNotice: (f: (n: { run: string; text: string }) => void) => { notice.add(f); return () => notice.delete(f) },
      onWindows: (f: (w: Windows) => void) => { wins.add(f); return () => wins.delete(f) },
    },
  }
}
const servers: { stop: () => void }[] = [], clients: FlowClient[] = []
afterEach(() => { clients.splice(0).forEach(c => c.close()); servers.splice(0).forEach(s => s.stop()) })

function start() {
  const data = mkdtempSync(join(tmpdir(), 'flow-srv-'))
  const store = new EventStore(':memory:')
  store.append('fso-1', 'human', { type: 'run.created', ticket: '#1', title: 'One', project: 'fso', base: 'origin/develop' })
  mkdirSync(join(data, 'runs', 'fso-1'), { recursive: true })
  writeFileSync(join(data, 'runs', 'fso-1', 'plan.md'), '# Plan\n\nDo it.\n')
  const f = fakeService()
  const s = serve({ service: f.svc, store, dataDir: data, port: 0, token: 'secret-token' })
  servers.push(s)
  const connect = async (token = 'secret-token') => { const c = await FlowClient.connect(`ws://127.0.0.1:${s.port}`, token); clients.push(c); return c }
  return { s, store, f, connect }
}

describe('the service socket', () => {
  test('a wrong or missing token is refused before any data is sent', async () => {
    const t = start()
    expect((await fetch(`http://127.0.0.1:${t.s.port}/?token=wrong`)).status).toBe(401)
    await expect(t.connect('wrong')).rejects.toThrow(/refused/)
  })
  test('on connect: every run\'s state and the plan windows', async () => {
    const c = await start().connect()
    expect(c.runs.get('fso-1')).toMatchObject({ ticket: '#1', stage: 'setup' })
    expect(c.windows.week?.utilization).toBe(0.59)
  })
  test('events are pushed as they happen, with the run\'s new state', async () => {
    const t = start(), c = await t.connect()
    const seen = new Promise(r => c.listen(m => m.type === 'event' && r(m)))
    t.store.append('fso-1', 'engine', { type: 'setup.done' })
    expect(await seen).toMatchObject({ event: { type: 'setup.done' }, state: { stage: 'plan' } })
    expect(c.runs.get('fso-1')!.stage).toBe('plan')
  })
  test('commands go to the service and come back with its reply', async () => {
    const t = start(), c = await t.connect()
    expect(await c.send({ cmd: 'approve', run: 'fso-1', answers: { Q1: 'yes' } })).toEqual({ ok: true, run: 'fso-1' })
    expect(await c.send({ cmd: 'ship', run: 'nope' })).toEqual({ ok: false, error: 'no run nope' })
    expect(t.f.sent[0]).toEqual({ cmd: 'approve', run: 'fso-1', answers: { Q1: 'yes' } })
  })
  test('notices and plan windows are pushed', async () => {
    const t = start(), c = await t.connect()
    const got = new Promise(r => c.listen(m => m.type === 'notice' && r(m)))
    t.f.emitNotice({ run: 'fso-1', text: 'commit refused' })
    expect(await got).toMatchObject({ notice: { text: 'commit refused' } })
    const w = new Promise(r => c.listen(m => m.type === 'windows' && r(m)))
    t.f.emitWindows({ fiveHour: { utilization: 0.4, resetsAt: 2, status: 'allowed' } })
    await w
    expect(c.windows.fiveHour?.utilization).toBe(0.4)
  })
  test('the run detail can read its events and its plan; other files are refused', async () => {
    const t = start(), c = await t.connect()
    expect((await c.events('fso-1')).map(e => e.type)).toEqual(['run.created'])
    expect(await c.file('fso-1', 'plan.md')).toBe('# Plan\n\nDo it.\n')
    expect(await c.file('fso-1', 'pr.md')).toBe('')
    await expect(c.file('fso-1', '../../token' as 'plan.md')).rejects.toThrow(/not a run file/)
  })
})
