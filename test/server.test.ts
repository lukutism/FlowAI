import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FlowClient } from '../src/client.ts'
import { serve } from '../src/server.ts'
import type { Command, Reply } from '../src/service.ts'
import { EventStore } from '../src/store.ts'
import type { Windows } from '../src/usage.ts'
import type { Snapshot } from '../src/resources.ts'
import { appendTranscript, type Entry } from '../src/transcript.ts'

// The screen and the CLI talk to the background service over a local WebSocket with a token only the user can
// read (a web page could otherwise reach ws://localhost and press "ship").
function fakeService() {
  const agent = new Set<(run: string, e: Entry) => void>()
  const notice = new Set<(n: { run: string; text: string }) => void>(), wins = new Set<(w: Windows) => void>(), res = new Set<(r: Snapshot) => void>()
  const sent: Command[] = []
  return {
    sent, emitAgent: (run: string, e: Entry) => agent.forEach(f => f(run, e)), emitNotice: (n: { run: string; text: string }) => notice.forEach(f => f(n)), emitWindows: (w: Windows) => wins.forEach(f => f(w)), emitResources: (r: Snapshot) => res.forEach(f => f(r)),
    svc: {
      dispatch: (c: Command): Reply => { sent.push(c); return 'run' in c && c.run === 'nope' ? { ok: false, error: 'no run nope' } : { ok: true, run: 'run' in c ? c.run : 'x' } },
      windows: (): Windows => ({ week: { utilization: 0.59, resetsAt: 1, status: 'allowed' } }),
      onNotice: (f: (n: { run: string; text: string }) => void) => { notice.add(f); return () => notice.delete(f) },
      onWindows: (f: (w: Windows) => void) => { wins.add(f); return () => wins.delete(f) },
      resources: (): Snapshot => ({ limits: { agents: 2, builds: 2, devices: 4 }, holders: { agents: ['fso-1'], builds: [], devices: [] }, waiting: [] }),
      onAgent: (f: (run: string, e: Entry) => void) => { agent.add(f); return () => agent.delete(f) },
      onProjects: () => () => {},
      query: async (q: { q: string }) => { if (q.q === 'lookup') return { title: 'Picking quantity' }; throw new Error('no such ticket') },
      projects: () => [{ key: 'fso', name: 'FSO', tracker: 'azure' as const, forge: 'azure' as const, repos: ['mobile', 'portal'], devices: ['android' as const], patches: ['mobile'], deadlineMinutes: 30 }],
      onResources: (f: (r: Snapshot) => void) => { res.add(f); return () => res.delete(f) },
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
  return { s, store, f, connect, data }
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
  test('the shared slots come with the snapshot and are pushed when they change', async () => {
    const t = start(), c = await t.connect()
    expect(c.resources?.holders.agents).toEqual(['fso-1'])
    const got = new Promise(r => c.listen(m => m.type === 'resources' && r(m)))
    t.f.emitResources({ limits: { agents: 2, builds: 2, devices: 4 }, holders: { agents: [], builds: ['fso-1'], devices: [] }, waiting: [{ run: 'fso-2', kind: 'builds' }] })
    await got
    expect(c.resources?.waiting).toEqual([{ run: 'fso-2', kind: 'builds' }])
  })
  test('the snapshot brings the latest events of all runs and the projects; pushed events join them', async () => {
    const t = start(), c = await t.connect()
    expect(c.recent.map(e => e.type)).toEqual(['run.created'])
    expect(c.projects.map(p => p.key)).toEqual(['fso'])
    const seen = new Promise(r => c.listen(m => m.type === 'event' && r(m)))
    t.store.append('fso-1', 'engine', { type: 'setup.done' })
    await seen
    expect(c.recent.map(e => e.type)).toEqual(['run.created', 'setup.done'])
  })
  test('a connection the service drops says so', async () => {
    const t = start(), c = await t.connect()
    expect(c.connected).toBe(true)
    const closed = new Promise(r => c.listen(m => m.type === 'closed' && r(m)))
    t.s.stop()
    await closed
    expect(c.connected).toBe(false)
  })
  test('the agent\'s session: what was recorded, then each new entry as it comes', async () => {
    const t = start()
    appendTranscript(t.data, 'fso-1', { at: 1, own: true, kind: 'text', text: 'earlier words' })
    const c = await t.connect()
    expect((await c.transcript('fso-1')).map(e => e.kind === 'text' && e.text)).toEqual(['earlier words'])
    const got = new Promise(r => c.listen(m => m.type === 'agent' && r(m)))
    t.f.emitAgent('fso-1', { at: 2, own: true, kind: 'tool', id: 'x', name: 'Bash', input: { command: 'yarn tsc' } })
    expect(await got).toMatchObject({ run: 'fso-1', entry: { kind: 'tool', name: 'Bash' } })
  })
  test('a run\'s logs: the last lines of Metro\'s, the dev server\'s, the device\'s; other names are refused', async () => {
    const t = start()
    writeFileSync(join(t.data, 'runs', 'fso-1', 'metro.log'), Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n') + '\n')
    const c = await t.connect()
    const lines = await c.log('fso-1', 'metro', 5)
    expect(lines).toEqual(['line 295', 'line 296', 'line 297', 'line 298', 'line 299'])
    expect(await c.log('fso-1', 'devserver', 5)).toEqual([])
    await expect(c.log('fso-1', '../token' as 'metro', 5)).rejects.toThrow(/not a run log/)
  })
  test('a run\'s changes: each changed file with its added and removed lines, new files included', async () => {
    const t = start()
    const wt = mkdtempSync(join(tmpdir(), 'flow-srv-wt-'))
    const g = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: wt, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
    g('init', '-q'); writeFileSync(join(wt, 'a.ts'), 'one\ntwo\n'); g('add', '.'); g('commit', '-qm', 'b')
    writeFileSync(join(wt, 'a.ts'), 'one\nTWO\nthree\n'); writeFileSync(join(wt, 'new.ts'), 'x\ny\n')
    writeFileSync(join(t.data, 'runs', 'fso-1', 'run.json'), JSON.stringify({ repos: [{ key: 'mobile', worktree: wt, base: 'origin/develop' }] }))
    const c = await t.connect()
    expect(await c.changes('fso-1')).toEqual([{ repo: 'mobile', file: 'a.ts', added: 2, removed: 1, status: 'M' }, { repo: 'mobile', file: 'new.ts', added: 2, removed: 0, status: 'A' }])
    expect(await c.changes('fso-9')).toEqual([])
    const d = await c.diff('fso-1')
    expect(d.map(x => [x.file, x.status, x.added, x.removed])).toEqual([['a.ts', 'M', 2, 1], ['new.ts', 'A', 2, 0]])
    expect(d[0]!.patch).toContain('-two\n+TWO\n+three')
    expect(d[1]!.patch).toMatch(/new file mode[\s\S]*\+x\n\+y/)
    // once committed (as ship does), the change still counts: from where the branch left its base
    g('branch', 'base-line', 'HEAD'); g('add', '.'); g('commit', '-qm', 'the change')
    writeFileSync(join(t.data, 'runs', 'fso-1', 'run.json'), JSON.stringify({ repos: [{ key: 'mobile', worktree: wt, base: 'base-line' }] }))
    expect(await c.changes('fso-1')).toEqual([{ repo: 'mobile', file: 'a.ts', added: 2, removed: 1, status: 'M' }, { repo: 'mobile', file: 'new.ts', added: 2, removed: 0, status: 'A' }])
  })
  test('the new-run form\'s questions get their answers, or the error', async () => {
    const c = await start().connect()
    expect(await c.query({ q: 'lookup', project: 'fso', ticket: 1 })).toEqual({ title: 'Picking quantity' })
    await expect(c.query({ q: 'bases', project: 'fso' })).rejects.toThrow(/no such ticket/)
  })
  test('the run detail can read its events and its plan; other files are refused', async () => {
    const t = start(), c = await t.connect()
    expect((await c.events('fso-1')).map(e => e.type)).toEqual(['run.created'])
    expect(await c.file('fso-1', 'plan.md')).toBe('# Plan\n\nDo it.\n')
    expect(await c.file('fso-1', 'pr.md')).toBe('')
    await expect(c.file('fso-1', '../../token' as 'plan.md')).rejects.toThrow(/not a run file/)
  })
})

describe('a run\'s device in the browser', () => {
  const withDevice = () => {
    const t = start()
    const log = join(t.data, 'adb.log')
    writeFileSync(join(t.data, 'runs', 'fso-1', 'device.json'), JSON.stringify({ run: 'fso-1', platform: 'android', id: 'emulator-5700', consolePort: 5700, metroPort: 8300, pids: [] }))
    process.env.FLOW_ADB = join(import.meta.dir, 'fake-adb.ts'); process.env.FAKE_ADB_LOG = log
    const url = (p: string, token = 'secret-token') => `http://127.0.0.1:${t.s.port}/device/fso-1${p}?token=${token}`
    return { ...t, url, log }
  }
  test('the page, a frame and an input, each only with the token', async () => {
    const t = withDevice()
    expect((await fetch(t.url('', 'wrong'))).status).toBe(401)
    const page = await fetch(t.url(''))
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('emulator-5700')
    const f = await fetch(t.url('/frame'))
    expect(f.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await f.arrayBuffer())[1]).toBe(0x50)
    const r = await fetch(t.url('/input'), { method: 'POST', body: JSON.stringify({ type: 'tap', x: 10, y: 20 }) })
    expect(r.status).toBe(204)
    expect(require('node:fs').readFileSync(t.log, 'utf8')).toContain('["-s","emulator-5700","shell","input","tap","10","20"]')
  })
  test('an input that is not one is refused; a run without a device says so', async () => {
    const t = withDevice()
    expect((await fetch(t.url('/input'), { method: 'POST', body: JSON.stringify({ type: 'exec', cmd: 'reboot' }) })).status).toBe(400)
    expect((await fetch(`http://127.0.0.1:${t.s.port}/device/fso-2?token=secret-token`)).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${t.s.port}/device/..%2Fx?token=secret-token`)).status).toBe(404)
  })
})

describe('the screen\'s connection after the service restarts', () => {
  test('it reconnects to the new service (another port), gets its state, and requests work again', async () => {
    const t = start()
    let target = { url: `ws://127.0.0.1:${t.s.port}`, token: 'secret-token' }
    const c = await FlowClient.connect(target.url, target.token, async () => target)
    clients.push(c)
    const seen: string[] = []
    c.listen(m => seen.push(m.type))
    t.s.stop()
    await Bun.sleep(100)
    expect(c.connected).toBe(false)
    // a request while it is away is answered at once, not left hanging
    expect(await c.send({ cmd: 'release', run: 'fso-9' })).toMatchObject({ ok: false, error: expect.stringMatching(/not connected/) })
    const store = new EventStore(':memory:')
    store.append('fso-9', 'human', { type: 'run.created', ticket: '#9', title: 'Nine', project: 'fso', base: 'origin/develop' })
    const s2 = serve({ service: fakeService().svc, store, dataDir: t.data, port: 0, token: 'secret-token' })
    servers.push(s2)
    target = { url: `ws://127.0.0.1:${s2.port}`, token: 'secret-token' }
    for (let i = 0; i < 40 && !c.connected; i++) await Bun.sleep(100)
    expect(c.connected).toBe(true)
    expect([...c.runs.keys()]).toEqual(['fso-9'])
    expect(seen).toContain('snapshot')
    expect(await c.send({ cmd: 'release', run: 'fso-9' })).toMatchObject({ ok: true })
  })
})

describe('the device page: logs and other devices', () => {
  const withDevice = () => {
    const t = start()
    writeFileSync(join(t.data, 'runs', 'fso-1', 'device.json'), JSON.stringify({ run: 'fso-1', platform: 'android', id: 'emulator-5700', consolePort: 5700, metroPort: 8300, pids: [] }))
    process.env.FLOW_ADB = join(import.meta.dir, 'fake-adb.ts'); process.env.FAKE_ADB_LOG = join(t.data, 'adb.log')
    return { ...t, url: (p: string) => `http://127.0.0.1:${t.s.port}${p}${p.includes('?') ? '&' : '?'}token=secret-token` }
  }
  test("the app's log: its JS console and errors, from the run's own device", async () => {
    const t = withDevice()
    const text = await (await fetch(t.url('/device/fso-1/log'))).text()
    expect(text).toContain('TypeError: x is undefined')
    // the console view: entries with their level, objects parsed to open; the native view: the rest
    const entries = await (await fetch(t.url('/device/fso-1/log?view=console'))).json() as { level: string; text: string; values: unknown }[]
    expect(entries.map(e => e.level)).toEqual(['log', 'error', 'log'])
    expect(entries[2]!.values).toEqual([{ kind: 'string', text: 'faq' }, { kind: 'object', entries: [['items', { kind: 'array', items: [{ kind: 'object', entries: [['a', { kind: 'number', text: '1' }]] }] }]] }])
    expect(await (await fetch(t.url('/device/fso-1/log?view=native'))).text()).toBe('10-26 11:08:04.000 D/OkHttp  ( 123): --> GET https://api.example/faq')
    // DevTools needs the run's own Metro: nothing listens on the test's port
    expect((await fetch(t.url('/device/fso-1/devtools'), { method: 'POST' })).status).toBe(502)
    expect(require('node:fs').readFileSync(join(t.data, 'adb.log'), 'utf8')).toContain('"-s","emulator-5700","logcat"')
  })
  test('the devices to switch to: the runs\' own, then emulators no run holds; one of those can be opened too', async () => {
    const t = withDevice()
    expect(await (await fetch(t.url('/devices'))).json()).toEqual([{ name: 'fso-1', label: 'fso-1 · android emulator-5700' }, { name: 'emulator-5790', label: 'emulator-5790 · not a flow run' }])
    expect((await fetch(t.url('/device/emulator-5790'))).status).toBe(200)
    expect((await fetch(t.url('/device/emulator-5999'))).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${t.s.port}/devices`)).status).toBe(401)
  })
})
