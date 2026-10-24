import { spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fill, sh, tail } from './sh.ts'

/**
 * A run's own device (emulator or simulator) and its Metro, from the project's commands. flow owns the lifecycle:
 * free ports, background processes (each in its own process group, so stopping takes their children too),
 * readiness, the state file, and cleanup on failure and at the end. Placeholders in the commands: {run}, {id},
 * {consolePort}, {metroPort}, {worktree}, {runDir}, {template}.
 */
export interface DeviceCommands {
  template?: string
  /** in the app's worktree, before anything else (prebuild, pods) */
  prepare?: string
  /** makes the run's own device; prints its id when `id` is not given (simctl clone prints the UDID) */
  create?: string
  id?: string
  boot: string
  /** boot keeps running until stopped (an emulator) rather than returning (simctl boot) */
  bootStays: boolean
  /** exits 0 once the device has booted (polled) */
  ready: string
  /** builds and installs the app, pointed at the run's Metro */
  install?: string
  stop?: string
  remove?: string
}
export interface DeviceSpec { metro: string; consolePortStart: number; metroPortStart: number; android?: DeviceCommands; ios?: DeviceCommands }
export interface DeviceState { run: string; platform: 'android' | 'ios'; id: string; consolePort: number; metroPort: number; pids: number[] }

async function must(what: string, cmd: string, cwd: string) {
  const r = await sh(cmd, cwd)
  if (r.code !== 0) throw new Error(`${what} failed (${cmd}):\n${tail(r.err || r.out)}`)
  return r.out
}

/** a background process in its own process group, its output in a log file */
function background(cmd: string, cwd: string, log: string): number {
  const fd = openSync(log, 'a')
  const p = spawn('sh', ['-c', cmd], { cwd, detached: true, stdio: ['ignore', fd, fd] })
  p.unref()
  return p.pid!
}

const canBind = (port: number) => { try { Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } }).stop(true); return true } catch { return false } }

/** the first port from start (in steps) that nothing listens on and no other run has taken */
export async function freePort(start: number, step: number, taken: Set<number> = new Set()): Promise<number> {
  for (let p = start; p < start + step * 200; p += step) if (!taken.has(p) && canBind(p)) return p
  throw new Error(`no free port from ${start}`)
}

async function until(ok: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) { if (await ok()) return true; await Bun.sleep(300) }
  return ok()
}

export async function startDevice(o: { spec: DeviceSpec; platform: 'android' | 'ios'; run: string; runDir: string; worktree: string; taken?: Set<number>; readyTimeoutMs?: number }): Promise<DeviceState> {
  const cmds = o.spec[o.platform]
  if (!cmds) throw new Error(`the project has no ${o.platform} device commands`)
  const consolePort = await freePort(o.spec.consolePortStart, 2, o.taken)
  const metroPort = await freePort(o.spec.metroPortStart, 1, o.taken)
  const vars: Record<string, string | number | undefined> = { run: o.run, consolePort, metroPort, worktree: o.worktree, runDir: o.runDir, template: cmds.template }
  const state: DeviceState = { run: o.run, platform: o.platform, id: cmds.id ? fill(cmds.id, vars) : '', consolePort, metroPort, pids: [] }
  const timeout = o.readyTimeoutMs ?? 180_000
  const deviceLog = join(o.runDir, 'device.log'), metroLog = join(o.runDir, 'metro.log')
  try {
    if (cmds.prepare) await must('prepare', fill(cmds.prepare, vars), o.worktree)
    if (cmds.create) {
      const out = await must('creating the device', fill(cmds.create, vars), o.runDir)
      if (!state.id) state.id = out.trim().split('\n').filter(Boolean).pop() ?? ''
    }
    if (!state.id) throw new Error('the device has no id: give "id" or a "create" that prints it')
    vars.id = state.id
    if (cmds.bootStays) state.pids.push(background(fill(cmds.boot, vars), o.runDir, deviceLog))
    else await must('booting the device', fill(cmds.boot, vars), o.runDir)
    if (!(await until(async () => (await sh(fill(cmds.ready, vars), o.runDir)).code === 0, timeout)))
      throw new Error(`device ${state.id} not ready after ${Math.round(timeout / 1000)} s:\n${existsSync(deviceLog) ? tail(readFileSync(deviceLog, 'utf8')) : '(no device log)'}`)
    state.pids.push(background(fill(o.spec.metro, vars), o.worktree, metroLog))
    const metroUp = () => fetch(`http://127.0.0.1:${metroPort}/status`).then(r => r.text()).then(t => t.includes('packager-status:running'), () => false)
    if (!(await until(metroUp, Math.max(timeout, 60_000))))
      throw new Error(`Metro did not answer on :${metroPort}:\n${existsSync(metroLog) ? tail(readFileSync(metroLog, 'utf8')) : '(no Metro log)'}`)
    if (cmds.install) await must('installing the app', fill(cmds.install, vars), o.worktree)
    writeFileSync(join(o.runDir, 'device.json'), JSON.stringify(state, null, 2) + '\n')
    return state
  } catch (e) {
    await stopDevice(state, o.spec, o.runDir)
    throw e
  }
}

/** stop and remove the device, end its background processes (and their children), forget it */
export async function stopDevice(state: DeviceState, spec: DeviceSpec, runDir: string) {
  const cmds = spec[state.platform]
  const vars = { run: state.run, id: state.id, consolePort: state.consolePort, metroPort: state.metroPort, runDir, template: cmds?.template }
  if (cmds?.stop && state.id) await sh(fill(cmds.stop, vars), runDir)
  for (const pid of state.pids) {
    try { process.kill(-pid, 'SIGTERM') } catch {}
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
  await Bun.sleep(200)
  for (const pid of state.pids) { try { process.kill(-pid, 'SIGKILL') } catch {} }
  if (cmds?.remove) await sh(fill(cmds.remove, vars), runDir)
  rmSync(join(runDir, 'device.json'), { force: true })
}
