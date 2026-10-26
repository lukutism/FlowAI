import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAgent, type FakeTurn } from '../src/agent/fake.ts'
import type { Az } from '../src/azure.ts'
import { parseProject } from '../src/config.ts'
import { Pipeline } from '../src/pipeline.ts'
import { Resources } from '../src/resources.ts'
import { EventStore } from '../src/store.ts'
import { fullPlan } from './plans.ts'

// A run with its own dev server (a web app's): started during setup on a free port, named to the agent, its log in the
// run folder, stopped at ship or release. Stand-in: a tiny HTTP server.
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...a: string[]) => new TextDecoder().decode(Bun.spawnSync(['git', ...a], { cwd, env }).stdout).trim()
const SERVER = join(import.meta.dir, 'fake-metro-server.ts')
const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm', apiKeySource: 'none' })
const turn = (effect?: () => void): FakeTurn => ({ stream: `${init}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, session_id: 's', usage: {} })}`, effect })

function setup(o: { cmd?: string; portStart?: number; browser?: object; browserBin?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flow-dev-srv-'))
  const origin = join(root, 'o.git'), main = join(root, 'main')
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'develop', origin]); Bun.spawnSync(['git', 'clone', '-q', origin, main], { env })
  writeFileSync(join(main, 'a.ts'), 'x\n'); git(main, 'add', '.'); git(main, 'commit', '-qm', 'b'); git(main, 'push', '-q', 'origin', 'HEAD:develop')
  const portStart = o.portStart ?? 5310
  const project = parseProject({
    key: 'ex', name: 'Ex', worktrees: join(root, 'wt'), tracker: { kind: 'azure', org: 'https://dev.azure.com/x', project: 'x' }, forge: { kind: 'azure', org: 'https://dev.azure.com/x', project: 'x' },
    repos: [{ key: 'portal', path: main, defaultBase: 'origin/develop', verify: [],
      devServer: { cmd: o.cmd ?? `echo starting on {port}; exec ${process.execPath} ${SERVER} {port}`, portStart, url: 'https://localhost:{port}', ...(o.browser ? { browser: o.browser } : {}) } }],
    review: { enabled: false },
  }, 't')
  const az: Az = args => args.includes('work-item') ? { code: 0, out: JSON.stringify({ fields: { 'System.Title': 'T', 'System.WorkItemType': 'Bug' } }), err: '' }
    : args.includes('create') ? { code: 0, out: '{"pullRequestId": 9}', err: '' } : { code: 0, out: '{"comments":[]}', err: '' }
  const data = join(root, 'data'), run = join(data, 'runs', 'ex-5'), wt = join(root, 'wt', '5', 'portal')
  const agent = new FakeAgent([
    turn(() => { mkdirSync(run, { recursive: true }); writeFileSync(join(run, 'plan.md'), fullPlan()) }),
    turn(() => { writeFileSync(join(wt, 'a.ts'), 'y\n'); writeFileSync(join(run, 'pr.md'), '# Change a\n\nVerified: tsc → clean\nNot verified: nothing\n') }),
  ])
  const store = new EventStore(':memory:')
  const slots = new Resources({ agents: 2, builds: 2, devices: 2 })
  const made: unknown[] = []
  const pipe = new Pipeline({ store, project, az, dataDir: data, gitEnv: env, resources: slots, makeAgent: x => { made.push(x); return agent }, devServerReadyTimeoutMs: 4000, ...(o.browserBin ? { browserBin: o.browserBin } : {}) })
  return { made, pipe, store, agent, slots, run, data, portStart }
}

describe('a run with a dev server', () => {
  test('started during setup on a free port, named to the agent, logged; ship stops it', async () => {
    const t = setup()
    const run = await t.pipe.start(5, { devServer: true })
    try {
      expect(t.store.events(run).find(e => e.type === 'devserver.ready')).toMatchObject({ repo: 'portal', port: 5310, url: 'https://localhost:5310' })
      expect(t.store.state(run)!.devServer).toEqual({ repo: 'portal', port: 5310, url: 'https://localhost:5310' })
      expect((t.made[0] as { appendSystemPrompt?: string }).appendSystemPrompt).toContain('Dev server: portal at https://localhost:5310')
      expect(await (await fetch('http://127.0.0.1:5310/status')).text()).toBe('packager-status:running')
      expect(readFileSync(join(t.run, 'devserver.log'), 'utf8')).toContain('starting on 5310')
      await t.pipe.ship(run)
      await expect(fetch('http://127.0.0.1:5310/status')).rejects.toThrow()
      expect(t.store.state(run)!.devServer).toBeUndefined()
      expect(existsSync(join(t.run, 'devserver.json'))).toBe(false)
    } finally { await t.pipe.releaseDevice(run).catch(() => {}) }
  })
  test('one that never listens fails the setup with its log', async () => {
    const t = setup({ cmd: 'echo "vite: missing dependency @x/y"; exec sleep 60', portStart: 5330 })
    const run = await t.pipe.start(5, { devServer: true })
    expect(t.store.state(run)).toMatchObject({ status: 'failed', needs: { kind: 'setup', ask: expect.stringMatching(/dev server: .*not listening.*missing dependency/s) } })
    expect(t.slots.snapshot().holders.builds).toEqual([])
  })
  test('release stops it before ship', async () => {
    const t = setup({ portStart: 5350 })
    const run = await t.pipe.start(5, { devServer: true })
    await t.pipe.releaseDevice(run)
    await expect(fetch('http://127.0.0.1:5350/status')).rejects.toThrow()
    expect(t.store.events(run).some(e => e.type === 'devserver.stopped')).toBe(true)
  })
  test('a run asking for one with no repo that has one is refused', async () => {
    const t = setup()
    ;(t.pipe as unknown as { d: { project: { repos: { devServer?: unknown }[] } } }).d.project.repos[0]!.devServer = undefined
    await expect(t.pipe.start(5, { devServer: true })).rejects.toThrow(/no repo of this run has a dev server/)
  })
})

describe('restarting a run with a dev server', () => {
  test('its dev server is started again too; a shipped run refuses', async () => {
    const t = setup({ portStart: 5370 })
    const run = await t.pipe.start(5, { devServer: true })
    try {
      await t.pipe.restartDevice(run)
      expect(t.store.events(run).filter(e => e.type === 'devserver.ready')).toHaveLength(2)
      expect(t.store.state(run)!.devServer).toMatchObject({ repo: 'portal' })
      expect(await (await fetch(`http://127.0.0.1:${t.store.state(run)!.devServer!.port}/status`)).text()).toBe('packager-status:running')
      t.store.append(run, 'human', { type: 'run.done' })
      await expect(t.pipe.restartDevice(run)).rejects.toThrow(/is done/)
    } finally { await t.pipe.releaseDevice(run).catch(() => {}) }
  })
})

describe('a web run with a browser', () => {
  test("the browser tool drives the run's own session through its proxy; the brief says so; release closes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-ab-')), log = join(dir, 'calls'), bin = join(dir, 'agent-browser')
    writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${log}\necho "- button \\"Save\\" [ref=e2]"\n`, { mode: 0o755 })
    const t = setup({ portStart: 5390, browser: { start: 'https://qa.example.com/#/dev' }, browserBin: bin })
    const run = await t.pipe.start(5, { devServer: true })
    try {
      expect(t.pipe.tools(run).map(x => x.name)).toContain('browser')
      expect((t.made[0] as { appendSystemPrompt?: string }).appendSystemPrompt).toContain('drive it with the browser tool')
      const r = await t.pipe.callTool(run, 'browser', { action: 'snapshot' })
      expect(r).toEqual({ ok: true, text: '- button "Save" [ref=e2]' })
      expect(readFileSync(log, 'utf8')).toMatch(/--session flow-ex-5 --ignore-https-errors --proxy http:\/\/127\.0\.0\.1:\d+ --proxy-bypass <-loopback> open https:\/\/qa\.example\.com\/#\/dev/)
      expect((await t.pipe.callTool(run, 'browser', { action: 'open', target: 'https://elsewhere.example.net/' })).text).toMatch(/not one of the hosts/)
      await t.pipe.releaseDevice(run)
      expect(readFileSync(log, 'utf8').trim().split('\n').at(-1)).toBe('--session flow-ex-5 close')
    } finally { await t.pipe.releaseDevice(run).catch(() => {}) }
  })
})
