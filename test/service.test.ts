import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAgent, type FakeTurn } from '../src/agent/fake.ts'
import type { Az } from '../src/azure.ts'
import { parseProject } from '../src/config.ts'
import { Service } from '../src/service.ts'
import { EventStore } from '../src/store.ts'

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...a: string[]) => Bun.spawnSync(['git', ...a], { cwd, env })
const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, session_id: 's', usage: { input_tokens: 10, output_tokens: 10 } })
const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm', apiKeySource: 'none' })
const turn = (effect?: () => void): FakeTurn => ({ stream: `${init}\n${result}`, effect })

function setup(turns: (d: { root: string; data: string }) => FakeTurn[]) {
  const root = mkdtempSync(join(tmpdir(), 'flow-svc-'))
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'develop', join(root, 'origin.git')])
  Bun.spawnSync(['git', 'clone', '-q', join(root, 'origin.git'), join(root, 'main')], { env })
  writeFileSync(join(root, 'main', 'a.txt'), 'a\n'); git(join(root, 'main'), 'add', '.'); git(join(root, 'main'), 'commit', '-qm', 'base'); git(join(root, 'main'), 'push', '-q', 'origin', 'HEAD:develop')
  const project = parseProject({ key: 'ex', name: 'Ex', worktrees: join(root, 'wt'), tracker: { kind: 'azure', org: 'https://dev.azure.com/x', project: 'x' }, forge: { kind: 'azure', org: 'https://dev.azure.com/x', project: 'x' },
    repos: [{ key: 'mobile', path: join(root, 'main'), defaultBase: 'origin/develop', verify: [] }] }, 't')
  const az: Az = args => args.includes('work-item')
    ? { code: 0, out: JSON.stringify({ fields: { 'System.Title': 'T', 'System.WorkItemType': 'Bug' } }), err: '' }
    : { code: 0, out: '{"comments":[]}', err: '' }
  const data = join(root, 'data')
  let now = Date.parse('2026-10-25T10:00:00Z')
  const store = new EventStore(':memory:', () => now)
  const agent = new FakeAgent(turns({ root, data }))
  const svc = new Service({ store, projects: { ex: project }, az, dataDir: data, gitEnv: env, now: () => now, makeAgent: () => agent })
  const notices: string[] = []
  svc.onNotice(n => notices.push(`${n.run}: ${n.text}`))
  return { svc, store, notices, data, at: (iso: string) => { now = Date.parse(iso) } }
}
const planWith = (data: string, q: string) => () => { mkdirSync(join(data, 'runs', 'ex-1'), { recursive: true }); writeFileSync(join(data, 'runs', 'ex-1', 'plan.md'), `# Plan\n\nDo it.\n\n## Open questions\n${q}\n`) }

describe('Service: the background process that drives runs', () => {
  test('a command is accepted at once and runs in the background; the run is busy until it ends', async () => {
    const t = setup(d => [turn(planWith(d.data, '- Q1: x? — default: y'))])
    expect(t.svc.dispatch({ cmd: 'start', project: 'ex', ticket: 1 })).toEqual({ ok: true, run: 'ex-1' })
    expect(t.svc.dispatch({ cmd: 'message', run: 'ex-1', text: 'hi' })).toMatchObject({ ok: false, error: expect.stringMatching(/busy/) })
    await t.svc.idle()
    expect(t.store.state('ex-1')).toMatchObject({ stage: 'plan', status: 'needs-you' })
  })
  test('plan deadlines: the tick takes the defaults once a plan is overdue, not before', async () => {
    const t = setup(d => [turn(planWith(d.data, '- Q1: x? — default: y')), turn()])
    t.svc.dispatch({ cmd: 'start', project: 'ex', ticket: 1 }); await t.svc.idle()
    t.at('2026-10-25T10:20:00Z'); t.svc.tick(); await t.svc.idle()
    expect(t.store.state('ex-1')!.stage).toBe('plan')
    t.at('2026-10-25T10:31:00Z'); t.svc.tick(); await t.svc.idle()
    expect(t.store.state('ex-1')).toMatchObject({ plan: { decidedBy: 'deadline', answers: { Q1: 'y' } } })
  })
  test('a held plan stays with you, however late it gets', async () => {
    const t = setup(d => [turn(planWith(d.data, '- Q1 (held): change behaviour? — default: no'))])
    t.svc.dispatch({ cmd: 'start', project: 'ex', ticket: 1 }); await t.svc.idle()
    t.at('2026-10-26T10:00:00Z'); t.svc.tick(); await t.svc.idle()
    expect(t.store.state('ex-1')).toMatchObject({ stage: 'plan', status: 'needs-you', needs: { held: true } })
  })
  test('an action failing in the background reaches you as a notice', async () => {
    const t = setup(d => [turn(planWith(d.data, '- Q1: x? — default: y'))])
    t.svc.dispatch({ cmd: 'start', project: 'ex', ticket: 1 }); await t.svc.idle()
    expect(t.svc.dispatch({ cmd: 'ship', run: 'ex-1' })).toMatchObject({ ok: true })
    await t.svc.idle()
    expect(t.notices).toEqual([expect.stringMatching(/^ex-1: .*not ready to ship/)])
  })
  test('a fresh service knows the plan windows saved by earlier runs, before any turn', () => {
    const t = setup(() => [])
    void t
    const root = mkdtempSync(join(tmpdir(), 'flow-svc-w-'))
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'usage.json'), JSON.stringify({ week: { utilization: 0.59, resetsAt: 1, status: 'allowed' } }))
    const svc = new Service({ store: new EventStore(':memory:'), projects: {}, az: () => ({ code: 1, out: '', err: '' }), dataDir: root, makeAgent: () => new FakeAgent([]) })
    expect(svc.windows().week?.utilization).toBe(0.59)
  })
  test('commands for a run that doesn\'t exist, or an unknown project, are refused at once', () => {
    const t = setup(() => [])
    expect(t.svc.dispatch({ cmd: 'approve', run: 'ex-9' })).toMatchObject({ ok: false, error: expect.stringMatching(/no run ex-9/) })
    expect(t.svc.dispatch({ cmd: 'start', project: 'nope', ticket: 1 })).toMatchObject({ ok: false, error: expect.stringMatching(/no project nope/) })
  })
})
