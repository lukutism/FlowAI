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

// A run with a device: booted during setup, named to the agent, held as a device slot, stopped at ship.
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...a: string[]) => new TextDecoder().decode(Bun.spawnSync(['git', ...a], { cwd, env }).stdout).trim()
const METRO = join(import.meta.dir, 'fake-metro-server.ts')
const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm', apiKeySource: 'none' })
const turn = (effect?: () => void): FakeTurn => ({ stream: `${init}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, session_id: 's', usage: {} })}`, effect })

function setup(o: { ready?: string; consoleStart?: number; metroStart?: number; headless?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flow-rundev-'))
  const origin = join(root, 'o.git'), main = join(root, 'main'), marks = join(root, 'marks')
  mkdirSync(marks)
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'develop', origin]); Bun.spawnSync(['git', 'clone', '-q', origin, main], { env })
  writeFileSync(join(main, 'a.ts'), 'x\n'); git(main, 'add', '.'); git(main, 'commit', '-qm', 'b'); git(main, 'push', '-q', 'origin', 'HEAD:develop')
  const project = parseProject({
    key: 'ex', name: 'Ex', worktrees: join(root, 'wt'), tracker: { kind: 'azure', org: 'https://dev.azure.com/x', project: 'x' }, forge: { kind: 'azure', org: 'https://dev.azure.com/x', project: 'x' },
    repos: [{ key: 'mobile', path: main, defaultBase: 'origin/develop', verify: [] }], review: { enabled: false },
    devices: {
      metro: `${process.execPath} ${METRO} {metroPort}`, ...(o.headless !== undefined ? { headless: o.headless } : {}), consolePortStart: o.consoleStart ?? 25720, metroPortStart: o.metroStart ?? 28720,
      android: { id: 'emulator-{consolePort}', boot: `sh -c 'echo "{headless}" > ${marks}/window; touch ${marks}/booted-{consolePort}; exec sleep 300'`, bootStays: true,
        ready: o.ready ?? `test -f ${marks}/booted-{consolePort}`, install: `echo {id} > ${marks}/installed`, stop: `echo {id} > ${marks}/stopped` },
    },
  }, 't')
  const az: Az = args => args.includes('work-item') ? { code: 0, out: JSON.stringify({ fields: { 'System.Title': 'T', 'System.WorkItemType': 'Bug' } }), err: '' }
    : args.includes('create') ? { code: 0, out: '{"pullRequestId": 9}', err: '' } : { code: 0, out: '{"comments":[]}', err: '' }
  const data = join(root, 'data'), run = join(data, 'runs', 'ex-5'), wt = join(root, 'wt', '5', 'mobile')
  const agent = new FakeAgent([
    turn(() => { mkdirSync(run, { recursive: true }); writeFileSync(join(run, 'plan.md'), fullPlan()) }),
    turn(() => { writeFileSync(join(wt, 'a.ts'), 'y\n'); writeFileSync(join(run, 'pr.md'), '# Change a\n\nVerified: tsc → clean\nNot verified: nothing\n') }),
  ])
  const store = new EventStore(':memory:')
  const slots = new Resources({ agents: 2, builds: 2, devices: 1 })
  const made: { env?: Record<string, string> }[] = []
  const pipe = new Pipeline({ store, project, az, dataDir: data, gitEnv: env, resources: slots, makeAgent: o => { made.push(o); return agent }, deviceReadyTimeoutMs: 3000 })
  return { pipe, store, agent, slots, marks, run, data, made }
}

describe('a run with a device', () => {
  test('booted during setup, named to the agent, holding a device slot; ship stops it and frees the slot', async () => {
    const t = setup()
    const run = await t.pipe.start(5, { device: 'android' })
    try {
      const ready = t.store.events(run).find(e => e.type === 'device.ready')
      expect(ready).toMatchObject({ platform: 'android', id: 'emulator-25720', metroPort: 28720 })
      expect(t.store.events(run).map(e => e.type).indexOf('device.ready')).toBeLessThan(t.store.events(run).map(e => e.type).indexOf('setup.done'))
      expect((t.made[0] as { appendSystemPrompt?: string }).appendSystemPrompt).toContain('Device: android emulator-25720, Metro on port 28720')
      // adb in the agent's shell talks to this run's emulator, not whichever one is first
      expect(t.made[0]!.env).toMatchObject({ ANDROID_SERIAL: 'emulator-25720', RCT_METRO_PORT: '28720' })
      expect(t.slots.snapshot().holders.devices).toEqual([run])
      expect(t.store.state(run)!.device).toEqual({ platform: 'android', id: 'emulator-25720', metroPort: 28720 })
      await t.pipe.ship(run)
      expect(readFileSync(join(t.marks, 'stopped'), 'utf8')).toBe('emulator-25720\n')
      expect(t.slots.snapshot().holders.devices).toEqual([])
      expect(t.store.state(run)!.device).toBeUndefined()
      expect(t.store.events(run).some(e => e.type === 'device.released')).toBe(true)
    } finally { await t.pipe.releaseDevice(run).catch(() => {}) }
  })
  test('a device that never becomes ready fails the setup with its log, and frees its slot', async () => {
    const t = setup({ ready: 'false', consoleStart: 25740, metroStart: 28740 })
    const run = await t.pipe.start(5, { device: 'android' })
    expect(t.store.state(run)).toMatchObject({ status: 'failed', needs: { kind: 'setup', ask: expect.stringMatching(/device: .*not ready/) } })
    expect(t.slots.snapshot().holders.devices).toEqual([])
  })
  test('release stops the device before ship; a second release does nothing', async () => {
    const t = setup({ consoleStart: 25760, metroStart: 28760 })
    const run = await t.pipe.start(5, { device: 'android' })
    await t.pipe.releaseDevice(run)
    await t.pipe.releaseDevice(run)
    expect(existsSync(join(t.run, 'device.json'))).toBe(false)
    expect(t.store.events(run).filter(e => e.type === 'device.released')).toHaveLength(1)
  })
  test('ports another run\'s device holds are skipped', async () => {
    const t = setup({ consoleStart: 25780, metroStart: 28780 })
    mkdirSync(join(t.data, 'runs', 'ex-4'), { recursive: true })
    writeFileSync(join(t.data, 'runs', 'ex-4', 'device.json'), JSON.stringify({ run: 'ex-4', platform: 'android', id: 'emulator-25780', consolePort: 25780, metroPort: 28780, pids: [] }))
    const run = await t.pipe.start(5, { device: 'android' })
    try { expect(t.store.state(run)!.device).toEqual({ platform: 'android', id: 'emulator-25782', metroPort: 28781 }) }
    finally { await t.pipe.releaseDevice(run) }
  })
  test('a project without device commands refuses a device', async () => {
    const t = setup()
    ;(t.pipe as unknown as { d: { project: { devices?: unknown } } }).d.project.devices = undefined
    await expect(t.pipe.start(5, { device: 'ios' })).rejects.toThrow(/no devices configured/)
  })
})

describe('restarting a run\'s device', () => {
  test('stopped and booted again on the same run, with the commands as they are now', async () => {
    const t = setup({ consoleStart: 25760, metroStart: 28760 })
    const run = await t.pipe.start(5, { device: 'android' })
    try {
      await t.pipe.restartDevice(run)
      const types = t.store.events(run).map(e => e.type)
      expect(types.filter(x => x === 'device.ready')).toHaveLength(2)
      expect(types.lastIndexOf('device.released')).toBeLessThan(types.lastIndexOf('device.ready'))
      expect(t.store.state(run)!.device).toMatchObject({ platform: 'android' })
      expect(t.slots.snapshot().holders.devices).toEqual([run])
    } finally { await t.pipe.releaseDevice(run).catch(() => {}) }
  })
})

describe('an emulator that stops on its own', () => {
  test('booted again while the run holds it, noted, and the agent told with its next turn; a live or released one is left alone', async () => {
    const t = setup({ consoleStart: 25840, metroStart: 28840 })
    const run = await t.pipe.start(5, { device: 'android' })
    try {
      expect(await t.pipe.reviveDevice(run)).toBe(false) // still running
      const boot = (JSON.parse(readFileSync(join(t.run, 'device.json'), 'utf8')) as { pids: number[] }).pids[0]!
      writeFileSync(join(t.run, 'device.log'), "ERROR        | detected a hanging thread 'QEMU2 main loop'. No response for 15011 ms\n")
      process.kill(-boot, 'SIGKILL')
      await Bun.sleep(100)
      expect(await t.pipe.reviveDevice(run)).toBe(true)
      expect(t.store.events(run).filter(e => e.type === 'device.ready')).toHaveLength(2)
      expect(t.store.events(run).find(e => e.type === 'run.note')).toMatchObject({ text: expect.stringMatching(/booted again \(emulator-25840 stopped \(detected a hanging thread 'QEMU2 main loop'.*\)\) as emulator-25840/) })
      expect(t.pipe.takeQueued(run).join()).toMatch(/emulator-25840 stopped .* booted it again: emulator-25840 is up .* Launch the app again/)
      expect(t.slots.snapshot().holders.devices).toEqual([run])
      await t.pipe.releaseDevice(run)
      expect(await t.pipe.reviveDevice(run)).toBe(false)
    } finally { await t.pipe.releaseDevice(run).catch(() => {}) }
  })
})

describe('a setup cut off by a restart', () => {
  test('redone from the start: what it had made goes, the worktree and device are made again, and the run goes on to its plan', async () => {
    const t = setup({ consoleStart: 25860, metroStart: 28860 })
    const run = 'ex-5', root = join(t.run, '..', '..', '..', 'wt', '5'), wt = join(root, 'mobile')
    mkdirSync(t.run, { recursive: true })
    writeFileSync(join(t.run, 'run.json'), JSON.stringify({ id: 5, key: '#5', title: 'T', kind: 'bug', url: '', branch: 'fix/5', base: 'origin/develop', repos: [{ key: 'mobile', worktree: wt, base: 'origin/develop' }], worktree: wt, platform: 'android' }))
    writeFileSync(join(t.run, 'ticket.md'), '# #5 T\n\nThe walk is broken.\n')
    t.store.append(run, 'human', { type: 'run.created', ticket: '#5', title: 'T', project: 'ex', base: 'origin/develop', repos: ['mobile'] })
    const main = (t.pipe as unknown as { d: { project: { repos: { path: string }[] } } }).d.project.repos[0]!.path
    Bun.spawnSync(['git', 'worktree', 'add', '-q', '-b', 'fix/5', wt, 'origin/develop'], { cwd: main, env }) // made before the restart
    writeFileSync(join(wt, 'half.txt'), 'x')
    try {
      await t.pipe.redoSetup(run)
      const types = t.store.events(run).map(e => e.type)
      expect(types).toContain('setup.done')
      expect(types).toContain('device.ready')
      expect(existsSync(join(wt, 'half.txt'))).toBe(false)
      expect(t.store.events(run).find(e => e.type === 'run.note')).toMatchObject({ text: expect.stringMatching(/setup .*again/) })
      expect(t.store.state(run)!.stage).not.toBe('setup')
    } finally { await t.pipe.releaseDevice(run).catch(() => {}) }
  })
})

describe("the agent's own device", () => {
  test('restart through flow\'s device tool: booted again while the turn goes on; argent may drive it but not boot one', async () => {
    const t = setup({ consoleStart: 25880, metroStart: 28880 })
    const run = await t.pipe.start(5, { device: 'android' })
    try {
      const r = await t.pipe.callTool(run, 'device', { action: 'restart' })
      expect(r).toMatchObject({ ok: true, text: expect.stringMatching(/emulator-25880 is up with the app installed, Metro on 28880/) })
      expect(t.store.events(run).filter(e => e.type === 'device.ready')).toHaveLength(2)
      expect(t.store.events(run).find(e => e.type === 'run.note')).toMatchObject({ text: expect.stringMatching(/the agent asked for it/) })
      const deny = JSON.parse(readFileSync((t.made[0] as { settings: string }).settings, 'utf8')).permissions.deny as string[]
      expect(deny).toEqual(expect.arrayContaining(['mcp__argent__boot-device', 'mcp__argent__stop-all-simulator-servers']))
      expect(deny).not.toContain('mcp__argent')
    } finally { await t.pipe.releaseDevice(run).catch(() => {}) }
  })
})

describe("a run's window", () => {
  test('headless by default (the emulator without its window); a run that asks for its window gets it', async () => {
    const t = setup({ consoleStart: 25780, metroStart: 28780 })
    const run = await t.pipe.start(5, { device: 'android' })
    try { expect(readFileSync(join(t.marks, 'window'), 'utf8').trim()).toBe('-no-window -no-audio') } finally { await t.pipe.releaseDevice(run).catch(() => {}) }
    const u = setup({ consoleStart: 25800, metroStart: 28800 })
    const shown = await u.pipe.start(5, { device: 'android', headless: false })
    try { expect(readFileSync(join(u.marks, 'window'), 'utf8').trim()).toBe('') } finally { await u.pipe.releaseDevice(shown).catch(() => {}) }
  })
})

describe('a run without a device', () => {
  test("can't drive the devices running here; given one later, its agent's next turn has it", async () => {
    const t = setup({ consoleStart: 25820, metroStart: 28820 })
    const run = await t.pipe.start(5)
    const first = t.made[0] as { env?: Record<string, string>; settings: string; appendSystemPrompt?: string }
    expect(first.env).toMatchObject({ ANDROID_SERIAL: 'no-device-for-this-run' })
    expect(JSON.parse(readFileSync(first.settings, 'utf8')).permissions.deny).toContain('mcp__argent')
    expect(first.appendSystemPrompt).toContain('This run has no device of its own')
    expect(first.appendSystemPrompt).toContain('the human can add a device to this run')
    try {
      await t.pipe.restartDevice(run, 'android')
      expect(t.store.state(run)!.device).toMatchObject({ platform: 'android', id: 'emulator-25820' })
      ;(t.pipe as unknown as { agentFor(r: string): unknown }).agentFor(run)
      const next = t.made.at(-1) as { env?: Record<string, string>; settings: string; appendSystemPrompt?: string }
      expect(next.env).toMatchObject({ ANDROID_SERIAL: 'emulator-25820' })
      expect(JSON.parse(readFileSync(next.settings, 'utf8')).permissions?.deny ?? []).not.toContain('mcp__argent')
      expect(next.appendSystemPrompt).toContain('Device: android emulator-25820')
    } finally { await t.pipe.releaseDevice(run).catch(() => {}) }
  })
})
