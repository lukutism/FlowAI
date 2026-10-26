import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freePort, startDevice, stopDevice, type DeviceSpec } from '../src/device.ts'

// A run's device: the project's commands, flow's lifecycle (ports, background processes, readiness, cleanup).
// Stand-ins: the "emulator" is a sleeping process, the device is a file, Metro is a tiny HTTP server.
const METRO = join(import.meta.dir, 'fake-metro-server.ts')

function spec(dir: string, over: Partial<DeviceSpec['android'] & object> = {}): DeviceSpec {
  return {
    metro: `${process.execPath} ${METRO} {metroPort}`,
    consolePortStart: 25700, metroPortStart: 28700,
    android: {
      template: 'Pixel_9',
      prepare: `echo prepared > ${dir}/prepared`,
      create: `echo created-{run} > ${dir}/created`,
      id: 'emulator-{consolePort}',
      boot: `sh -c 'echo {grpcPort} > ${dir}/grpc; touch ${dir}/booted-{consolePort}; exec sleep 300'`,
      bootStays: true,
      ready: `test -f ${dir}/booted-{consolePort}`,
      install: `echo {id} {metroPort} > ${dir}/installed`,
      stop: `echo stopped {id} > ${dir}/stopped`,
      remove: `echo removed {run} > ${dir}/removed`,
      ...over,
    },
  }
}
function dirs() {
  const dir = mkdtempSync(join(tmpdir(), 'flow-dev-')), runDir = join(dir, 'run'), wt = join(dir, 'wt')
  mkdirSync(runDir); mkdirSync(wt)
  return { dir, runDir, wt }
}

describe('a run\'s device', () => {
  test('prepare, create, boot (kept running), ready, Metro answering on its port, install: the state names the device and the port', async () => {
    const d = dirs()
    const s = await startDevice({ spec: spec(d.dir), platform: 'android', run: 'fso-1', runDir: d.runDir, worktree: d.wt, readyTimeoutMs: 5000 })
    try {
      expect(s).toMatchObject({ platform: 'android', id: 'emulator-25700', consolePort: 25700, metroPort: 28700 })
      expect(readFileSync(join(d.dir, 'prepared'), 'utf8')).toBe('prepared\n')
      expect(readFileSync(join(d.dir, 'grpc'), 'utf8')).toBe('28700\n') // console + 3000, for argent
      expect(readFileSync(join(d.dir, 'installed'), 'utf8')).toBe('emulator-25700 28700\n')
      expect(await (await fetch('http://127.0.0.1:28700/status')).text()).toBe('packager-status:running')
      expect(JSON.parse(readFileSync(join(d.runDir, 'device.json'), 'utf8'))).toMatchObject({ id: 'emulator-25700', metroPort: 28700 })
    } finally { await stopDevice(s, spec(d.dir), d.runDir) }
  })
  test('headless: {headless} in the boot command is the platform\'s no-window flags; shown, it is nothing', async () => {
    for (const headless of [true, false]) {
      const d = dirs()
      const sp = { ...spec(d.dir, { boot: `sh -c 'echo "[{headless}]" > ${d.dir}/flags; touch ${d.dir}/booted-{consolePort}; exec sleep 300'` }), headless }
      const s = await startDevice({ spec: sp, platform: 'android', run: 'fso-1', runDir: d.runDir, worktree: d.wt, readyTimeoutMs: 5000 })
      try { expect(readFileSync(join(d.dir, 'flags'), 'utf8')).toBe(headless ? '[-no-window -no-audio]\n' : '[]\n') } finally { await stopDevice(s, sp, d.runDir) }
    }
  })
  test('stop: the device stopped and removed, the background processes gone, Metro no longer answering', async () => {
    const d = dirs()
    const s = await startDevice({ spec: spec(d.dir), platform: 'android', run: 'fso-2', runDir: d.runDir, worktree: d.wt, readyTimeoutMs: 5000 })
    await stopDevice(s, spec(d.dir), d.runDir)
    expect(readFileSync(join(d.dir, 'stopped'), 'utf8')).toBe('stopped emulator-25700\n')
    expect(readFileSync(join(d.dir, 'removed'), 'utf8')).toBe('removed fso-2\n')
    for (const pid of s.pids) expect(() => process.kill(pid, 0)).toThrow()
    await expect(fetch('http://127.0.0.1:28700/status')).rejects.toThrow()
    expect(existsSync(join(d.runDir, 'device.json'))).toBe(false)
  })
  test('the id printed by create when the project names none (a simulator clone prints its UDID)', async () => {
    const d = dirs()
    const sp = spec(d.dir, { create: 'echo 1A2B-UDID', id: undefined, boot: 'true', bootStays: false, ready: 'true', install: undefined })
    const s = await startDevice({ spec: sp, platform: 'android', run: 'fso-3', runDir: d.runDir, worktree: d.wt, readyTimeoutMs: 5000 })
    try { expect(s.id).toBe('1A2B-UDID') } finally { await stopDevice(s, sp, d.runDir) }
  })
  test('never ready: an error with the device log\'s last lines, and everything started so far is cleaned up', async () => {
    const d = dirs()
    const sp = spec(d.dir, { boot: `sh -c 'echo "emulator: PANIC: missing system image"; exec sleep 300'`, ready: 'false' })
    await expect(startDevice({ spec: sp, platform: 'android', run: 'fso-4', runDir: d.runDir, worktree: d.wt, readyTimeoutMs: 600 })).rejects.toThrow(/not ready after .*PANIC: missing system image/s)
    expect(readFileSync(join(d.dir, 'removed'), 'utf8')).toBe('removed fso-4\n')
  })
  test('a platform the project has no commands for is refused', async () => {
    const d = dirs()
    await expect(startDevice({ spec: spec(d.dir), platform: 'ios', run: 'x', runDir: d.runDir, worktree: d.wt })).rejects.toThrow(/no ios device commands/)
  })
})

describe('freePort', () => {
  test('the first port from the start that is free and not taken by another run', async () => {
    const busy = Bun.listen({ hostname: '127.0.0.1', port: 8800, socket: { data() {} } })
    try {
      expect(await freePort(8800, 1, new Set([8801]))).toBe(8802)
    } finally { busy.stop(true) }
  })
})
