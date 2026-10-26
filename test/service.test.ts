import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAgent, type FakeTurn } from '../src/agent/fake.ts'
import type { Az } from '../src/azure.ts'
import { parseProject } from '../src/config.ts'
import { Service } from '../src/service.ts'
import { readTranscript } from '../src/transcript.ts'
import { EventStore } from '../src/store.ts'
import type { EventBody } from '../src/run.ts'
import { fullPlan } from './plans.ts'

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...a: string[]) => Bun.spawnSync(['git', ...a], { cwd, env })
const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, session_id: 's', usage: { input_tokens: 10, output_tokens: 10 } })
const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm', apiKeySource: 'none' })
const turn = (effect?: () => void): FakeTurn => ({ stream: `${init}\n${result}`, effect })

function setup(turns: (d: { root: string; data: string }) => FakeTurn[], azMore?: (args: string[]) => ReturnType<Az> | undefined) {
  const root = mkdtempSync(join(tmpdir(), 'flow-svc-'))
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'develop', join(root, 'origin.git')])
  Bun.spawnSync(['git', 'clone', '-q', join(root, 'origin.git'), join(root, 'main')], { env })
  writeFileSync(join(root, 'main', 'a.txt'), 'a\n'); git(join(root, 'main'), 'add', '.'); git(join(root, 'main'), 'commit', '-qm', 'base'); git(join(root, 'main'), 'push', '-q', 'origin', 'HEAD:develop')
  const project = parseProject({ key: 'ex', name: 'Ex', worktrees: join(root, 'wt'), tracker: { kind: 'azure', org: 'https://dev.azure.com/x', project: 'x' }, forge: { kind: 'azure', org: 'https://dev.azure.com/x', project: 'x' },
    repos: [{ key: 'mobile', path: join(root, 'main'), defaultBase: 'origin/develop', verify: [] }] }, 't')
  const az: Az = args => azMore?.(args) ?? (args.includes('work-item')
    ? { code: 0, out: JSON.stringify({ fields: { 'System.Title': 'T', 'System.WorkItemType': 'Bug' } }), err: '' }
    : { code: 0, out: '{"comments":[]}', err: '' })
  const data = join(root, 'data')
  let now = Date.parse('2026-10-25T10:00:00Z')
  const store = new EventStore(':memory:', () => now)
  const agent = new FakeAgent(turns({ root, data }))
  const svc = new Service({ store, projects: { ex: project }, az, dataDir: data, gitEnv: env, now: () => now, makeAgent: () => agent })
  const notices: string[] = []
  svc.onNotice(n => notices.push(`${n.run}: ${n.text}`))
  return { svc, store, notices, data, agent, at: (iso: string) => { now = Date.parse(iso) } }
}
const planWith = (data: string, q: string) => () => { mkdirSync(join(data, 'runs', 'ex-1'), { recursive: true }); writeFileSync(join(data, 'runs', 'ex-1', 'plan.md'), fullPlan(q)) }

describe('Service: the background process that drives runs', () => {
  test('a command is accepted at once and runs in the background; the run is busy until it ends', async () => {
    const t = setup(d => [turn(planWith(d.data, '- Q1: x? — default: y'))])
    expect(t.svc.dispatch({ cmd: 'start', project: 'ex', ticket: 1 })).toEqual({ ok: true, run: 'ex-1' })
    expect(t.svc.dispatch({ cmd: 'approve', run: 'ex-1' })).toMatchObject({ ok: false, error: expect.stringMatching(/busy/) })
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
  test('the service shares one set of slots across runs; a run waiting for one says for what, in words', async () => {
    const t = setup(d => [turn(planWith(d.data, '- Q1: x? — default: y'))])
    // the default allows 2 builds at once: another run holds both
    const held = [await t.svc.slots.acquire('another', 'builds'), await t.svc.slots.acquire('another', 'builds')]
    t.store.subscribe(e => { if (e.type === 'run.waiting') held.forEach(f => f()) })
    t.svc.dispatch({ cmd: 'start', project: 'ex', ticket: 1 }); await t.svc.idle()
    expect(t.store.events('ex-1').find(e => e.type === 'run.waiting')).toMatchObject({ resource: 'a build slot' })
  })
  test('a device the project has no commands for is refused at once; release of a run without a device does nothing', async () => {
    const t = setup(d => [turn(planWith(d.data, '- Q1: x? — default: y'))])
    expect(t.svc.dispatch({ cmd: 'start', project: 'ex', ticket: 1, device: 'ios' })).toMatchObject({ ok: false, error: expect.stringMatching(/no devices configured for ios/) })
    t.svc.dispatch({ cmd: 'start', project: 'ex', ticket: 1 }); await t.svc.idle()
    expect(t.svc.dispatch({ cmd: 'release', run: 'ex-1' })).toEqual({ ok: true, run: 'ex-1' })
    await t.svc.idle()
    expect(t.notices).toEqual([])
    expect(t.store.events('ex-1').some(e => e.type === 'device.released')).toBe(false)
  })
  test('the agent\'s session is recorded and pushed as it happens: flow\'s prompts, your messages, the agent\'s words and tools', async () => {
    const say = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the picking list.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/a.ts' } }] } })
    const t = setup(d => [{ stream: `${init}\n${say}\n${result}`, effect: planWith(d.data, '- Q1: x? — default: y') }, turn()])
    const pushed: string[] = []
    t.svc.onAgent((run, e) => pushed.push(`${run} ${e.kind}`))
    t.svc.dispatch({ cmd: 'start', project: 'ex', ticket: 1 }); await t.svc.idle()
    t.svc.dispatch({ cmd: 'message', run: 'ex-1', text: 'please check the order list too' }); await t.svc.idle()
    const tr = readTranscript(t.data, 'ex-1')
    expect(tr.map(e => e.kind)).toEqual(['prompt', 'session', 'text', 'tool', 'result', 'prompt', 'session', 'result'])
    expect(tr[0]).toMatchObject({ kind: 'prompt', from: 'flow', own: true, at: Date.parse('2026-10-25T10:00:00Z') })
    expect(tr[2]).toMatchObject({ kind: 'text', text: 'Looking at the picking list.' })
    expect(tr[3]).toMatchObject({ kind: 'tool', name: 'Read', input: { file_path: 'src/a.ts' } })
    expect(tr[5]).toMatchObject({ kind: 'prompt', from: 'you', text: 'please check the order list too' })
    expect(pushed).toEqual(tr.map(e => `ex-1 ${e.kind}`))
    expect(readTranscript(t.data, 'nope')).toEqual([])
  })
  test('a project\'s settings: read as written, saved only when they are valid, and new runs get them at once', async () => {
    const t = setup(() => [])
    const dir = mkdtempSync(join(tmpdir(), 'flow-projects-'))
    const raw = { key: 'ex', name: 'Ex', worktrees: join(t.data, 'wt'), tracker: { kind: 'azure', org: 'https://dev.azure.com/x', project: 'x' }, forge: { kind: 'azure', org: 'https://dev.azure.com/x', project: 'x' },
      repos: [{ key: 'mobile', path: '/r', defaultBase: 'origin/develop', verify: [] }] }
    writeFileSync(join(dir, 'ex.json'), JSON.stringify(raw, null, 2))
    const svc = new Service({ store: new EventStore(':memory:'), projects: { ex: parseProject(raw, 'ex.json') }, projectsDir: dir, az: () => ({ code: 1, out: '', err: '' }), dataDir: t.data, makeAgent: () => new FakeAgent([]) })
    expect(await svc.query({ q: 'projectFile', project: 'ex' })).toEqual({ path: join(dir, 'ex.json'), json: raw })
    const pushed: string[] = []
    svc.onProjects(ps => pushed.push(ps.map(p => p.name).join()))
    // a mistake is named, and nothing is written
    expect(svc.dispatch({ cmd: 'saveProject', project: 'ex', json: { ...raw, repos: [] } })).toMatchObject({ ok: false, error: expect.stringMatching(/repos/) })
    expect(JSON.parse(require('node:fs').readFileSync(join(dir, 'ex.json'), 'utf8')).repos).toHaveLength(1)
    // a good change is written (the old file kept beside it) and taken at once
    expect(svc.dispatch({ cmd: 'saveProject', project: 'ex', json: { ...raw, name: 'Example', plan: { deadlineMinutes: 45 } } })).toEqual({ ok: true, run: '' })
    expect(JSON.parse(require('node:fs').readFileSync(join(dir, 'ex.json'), 'utf8'))).toMatchObject({ name: 'Example', plan: { deadlineMinutes: 45 } })
    expect(JSON.parse(require('node:fs').readFileSync(join(dir, 'ex.json.bak'), 'utf8')).name).toBe('Ex')
    expect(svc.projects().find(p => p.key === 'ex')).toMatchObject({ name: 'Example', deadlineMinutes: 45 })
    expect(pushed).toEqual(['Example'])
    expect(svc.dispatch({ cmd: 'saveProject', project: 'ex', json: { ...raw, key: 'other' } })).toMatchObject({ ok: false, error: expect.stringMatching(/key/) })
  })
  test('commands for a run that doesn\'t exist, or an unknown project, are refused at once', () => {
    const t = setup(() => [])
    expect(t.svc.dispatch({ cmd: 'approve', run: 'ex-9' })).toMatchObject({ ok: false, error: expect.stringMatching(/no run ex-9/) })
    expect(t.svc.dispatch({ cmd: 'start', project: 'nope', ticket: 1 })).toMatchObject({ ok: false, error: expect.stringMatching(/no project nope/) })
  })
})

describe('Service: after a restart, and when a step throws', () => {
  test('runs that were mid-step stop for you saying why (they used to show "running" for good)', async () => {
    const t = setup(d => [turn(planWith(d.data, 'none')), turn()])
    t.store.append('ex-9', 'human', { type: 'run.created', ticket: '#9', title: 'x', project: 'ex', base: 'origin/develop' })
    t.store.append('ex-8', 'human', { type: 'run.created', ticket: '#8', title: 'y', project: 'ex', base: 'origin/develop' })
    t.store.append('ex-8', 'engine', { type: 'setup.done' })
    t.store.append('ex-8', 'engine', { type: 'run.paused', window: '5h', until: 1 })
    await t.svc.recover()
    expect(t.store.state('ex-9')).toMatchObject({ status: 'failed', needs: { ask: expect.stringMatching(/restarted during setup/) } })
    expect(t.store.state('ex-8')).toMatchObject({ status: 'blocked', needs: { ask: expect.stringMatching(/restarted during plan.*message/) } })
  })
  test('a step that throws blocks its run with the reason instead of leaving it running', async () => {
    const t = setup(() => [turn()])
    t.store.append('ex-7', 'human', { type: 'run.created', ticket: '#7', title: 'x', project: 'ex', base: 'origin/develop' })
    t.store.append('ex-7', 'engine', { type: 'setup.done' })
    t.store.append('ex-7', 'engine', { type: 'plan.submitted', summary: 'p', questions: [] })
    // no run.json: the message's step throws reading it
    t.svc.dispatch({ cmd: 'message', run: 'ex-7', text: 'go on' })
    await t.svc.idle()
    expect(t.store.state('ex-7')).toMatchObject({ status: 'blocked', needs: { ask: expect.stringMatching(/run\.json|ENOENT/) } })
  })
})

describe('Service: idle agents are closed', () => {
  test('a run that stops for you has its agent process closed (about 2 GB each); one still working keeps it', async () => {
    const t = setup(d => [turn(planWith(d.data, '- Q1: x? — default: y'))])
    let closed = 0
    ;(t.agent as unknown as { close: () => Promise<void> }).close = async () => { closed++ }
    t.svc.dispatch({ cmd: 'start', project: 'ex', ticket: 1 })
    await t.svc.idle()
    expect(t.store.state('ex-1')).toMatchObject({ status: 'needs-you' })
    expect(closed).toBe(1)
  })
})

describe('Service: commands it does not know', () => {
  test('are refused (one used to fall through to ship)', () => {
    const t = setup(() => [])
    t.store.append('ex-5', 'human', { type: 'run.created', ticket: '#5', title: 'x', project: 'ex', base: 'origin/develop' })
    expect(t.svc.dispatch({ cmd: 'nope', run: 'ex-5' } as never)).toMatchObject({ ok: false, error: expect.stringMatching(/unknown command nope/) })
  })
})

describe('Service: draft PRs merged or closed on the host', () => {
  const shipped = (t: ReturnType<typeof setup>, id: string, base = 'origin/develop', targets?: string[]) => {
    t.store.append(id, 'human', { type: 'run.created', ticket: '#1', title: 'x', project: 'ex', base })
    const steps: EventBody[] = [{ type: 'setup.done' }, { type: 'plan.submitted', summary: 'p', questions: [], ...(targets ? { targets } : {}) }, { type: 'build.done' }, { type: 'verify.result', ok: true, newFindings: [] }, { type: 'review.skipped', reason: 'off' }]
    for (const e of steps) t.store.append(id, 'engine', e)
    t.store.append(id, 'human', { type: 'pr.opened', url: 'https://dev.azure.com/x/x/_git/m/pullrequest/7', number: 7 })
  }
  test('merged: the run is done and removed (its folder archived); checked again only after a while', async () => {
    const calls: string[][] = []
    const t = setup(() => [], args => { calls.push(args); return args.includes('show') && args.includes('pr') ? { code: 0, out: '{"status":"completed"}', err: '' } : undefined })
    shipped(t, 'ex-1')
    t.svc.tick(); await t.svc.idle()
    expect(t.store.state('ex-1')).toBeUndefined()
    expect(t.store.events('ex-1').map(e => e.type).slice(-2)).toEqual(['run.done', 'run.removed'])
    expect(calls.filter(c => c.includes('show'))).toHaveLength(1)
  })
  test('merged on a release line with no port yet: done, not removed, saying so (the fix still has to reach the default line)', async () => {
    const merged = (args: string[]) => (args.includes('show') && args.includes('pr') ? { code: 0, out: '{"status":"completed"}', err: '' } : undefined)
    const t = setup(() => [], merged)
    shipped(t, 'ex-1', 'origin/patch/1.0')
    t.svc.tick(); await t.svc.idle()
    expect(t.store.state('ex-1')).toMatchObject({ status: 'done' })
    expect(t.notices.join('\n')).toMatch(/ex-1: .*patch\/1\.0.*no port.*flow port ex-1/)
    // with its port started, a merged release run goes as usual
    const u = setup(() => [], merged)
    shipped(u, 'ex-1', 'origin/patch/1.0'); shipped(u, 'ex-1-develop')
    u.svc.tick(); await u.svc.idle()
    expect(u.store.state('ex-1')).toBeUndefined()
  })
  test("the plan's Target lines decide: \"this base only\" on a release line goes; a line it names keeps the run until ported", async () => {
    const merged = (args: string[]) => (args.includes('show') && args.includes('pr') ? { code: 0, out: '{"status":"completed"}', err: '' } : undefined)
    const t = setup(() => [], merged)
    shipped(t, 'ex-1', 'origin/patch/1.0', [])
    t.svc.tick(); await t.svc.idle()
    expect(t.store.state('ex-1')).toBeUndefined()
    const u = setup(() => [], merged)
    shipped(u, 'ex-1', 'origin/develop', ['release/2.0'])
    u.svc.tick(); await u.svc.idle()
    expect(u.store.state('ex-1')).toMatchObject({ status: 'done' })
    expect(u.notices.join('\n')).toContain('no port to release/2.0 yet (flow port ex-1 --to release/2.0)')
  })
  test('still open: nothing changes, and the host is not asked again at the next tick', async () => {
    const calls: string[][] = []
    const t = setup(() => [], args => { calls.push(args); return args.includes('show') && args.includes('pr') ? { code: 0, out: '{"status":"active"}', err: '' } : undefined })
    shipped(t, 'ex-1')
    t.svc.tick(); await t.svc.idle(); t.svc.tick(); await t.svc.idle()
    expect(t.store.state('ex-1')).toMatchObject({ needs: { kind: 'pr' } })
    expect(calls.filter(c => c.includes('show'))).toHaveLength(1)
  })
  test('abandoned: done, the worktree kept (you may want the work)', async () => {
    const t = setup(() => [], args => (args.includes('show') && args.includes('pr') ? { code: 0, out: '{"status":"abandoned"}', err: '' } : undefined))
    shipped(t, 'ex-1')
    t.svc.tick(); await t.svc.idle()
    expect(t.store.state('ex-1')).toMatchObject({ status: 'done' })
  })
})

describe('Service: a message while the run is busy', () => {
  test('is queued, not refused; left over when the step ends, it is sent then', async () => {
    const t = setup(d => [turn(planWith(d.data, '- Q1: x? — default: y')), turn()])
    t.svc.dispatch({ cmd: 'start', project: 'ex', ticket: 1 })
    const r = t.svc.dispatch({ cmd: 'message', run: 'ex-1', text: 'use order 42' })
    expect(r).toMatchObject({ ok: true, note: expect.stringMatching(/queued/) })
    await t.svc.idle()
    expect(t.agent.prompts.some(p => p.includes('use order 42'))).toBe(true)
  })
})
