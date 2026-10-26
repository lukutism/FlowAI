import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fill, fillSh, livePids, logLine, sh, shLogged, tail } from './sh.ts'

/**
 * A run's own device (emulator or simulator) and its Metro, from the project's commands. flow owns the lifecycle:
 * free ports, background processes (each in its own process group, so stopping takes their children too),
 * readiness, the state file, and cleanup on failure and at the end. Placeholders in the commands: {run}, {id},
 * {consolePort}, {grpcPort} (the emulator's gRPC, which argent reads: consolePort + 3000), {metroPort}, {worktree}, {runDir}, {template}, {headless} (the emulator's no-window flags when headless).
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
  /**
   * the built app kept and installed again while its native inputs are the same (a run's JS comes from its own Metro):
   * inputs, paths in the worktree whose content decides the build (native code, the lockfile, an env file compiled
   * in); artifact, the built file; installFrom, installs {artifact} instead of building
   */
  cache?: { inputs: string[]; artifact: string; installFrom: string }
  stop?: string
  remove?: string
  /** the app's id (android package, iOS bundle id) */
  app?: string
}
/** headless: the emulator runs without its window ({headless} in the boot command); it is seen in the browser instead */
export interface DeviceSpec { metro: string; consolePortStart: number; metroPortStart: number; headless?: boolean; android?: DeviceCommands; ios?: DeviceCommands }
/** app: the app's id on it, when the project names it (its log, its relaunch) */
export interface DeviceState { run: string; platform: 'android' | 'ios'; id: string; consolePort: number; metroPort: number; pids: number[]; app?: string }

async function must(what: string, cmd: string, cwd: string, log?: string) {
  logLine(log, what)
  if (log) {
    const r = await shLogged(cmd, cwd, log)
    if (r.code !== 0) throw new Error(`${what} failed (${cmd}):\n${tail(r.out)}`)
    return r.out.trim()
  }
  const r = await sh(cmd, cwd)
  if (r.code !== 0) throw new Error(`${what} failed (${cmd}):\n${tail(r.err || r.out)}`)
  return r.out
}

/** a background process in its own process group, its output in a log file */
export function background(cmd: string, cwd: string, log: string): number {
  const fd = openSync(log, 'a')
  const p = spawn('sh', ['-c', cmd], { cwd, detached: true, stdio: ['ignore', fd, fd] })
  p.unref()
  return p.pid!
}

export const canBind = (port: number) => { try { Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } }).stop(true); return true } catch { return false } }

/** the first port from start (in steps) that nothing listens on and no other run has taken */
export async function freePort(start: number, step: number, taken: Set<number> = new Set()): Promise<number> {
  for (let p = start; p < start + step * 200; p += step) if (!taken.has(p) && canBind(p)) return p
  throw new Error(`no free port from ${start}`)
}

export async function until(ok: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) { if (await ok()) return true; await Bun.sleep(300) }
  return ok()
}

export async function startDevice(o: { spec: DeviceSpec; platform: 'android' | 'ios'; run: string; runDir: string; worktree: string; taken?: Set<number>; readyTimeoutMs?: number; log?: string; cacheDir?: string; mainCheckout?: string }): Promise<DeviceState> {
  const cmds = o.spec[o.platform]
  if (!cmds) throw new Error(`the project has no ${o.platform} device commands`)
  const consolePort = await freePort(o.spec.consolePortStart, 2, o.taken)
  const metroPort = await freePort(o.spec.metroPortStart, 1, o.taken)
  // a simulator has no window unless Simulator.app is opened; the emulator needs its flags
  const headless = o.spec.headless && o.platform === 'android' ? '-no-window -no-audio' : ''
  const vars: Record<string, string | number | undefined> = { run: o.run, consolePort, metroPort, worktree: o.worktree, runDir: o.runDir, template: cmds.template, grpcPort: consolePort + 3000 }
  // flow's own flags, several words: put in as they are (other values are quoted as one word each)
  const filled = (c: string) => fillSh(c.replaceAll('{headless}', headless), vars)
  const state: DeviceState = { run: o.run, platform: o.platform, id: cmds.id ? fill(cmds.id, vars) : '', consolePort, metroPort, pids: [], ...(cmds.app ? { app: cmds.app } : {}) }
  const timeout = o.readyTimeoutMs ?? 180_000
  const deviceLog = join(o.runDir, 'device.log'), metroLog = join(o.runDir, 'metro.log')
  try {
    if (cmds.prepare) await must('prepare', filled(cmds.prepare), o.worktree, o.log)
    if (cmds.create) {
      // its id is what it prints on stdout (a warning on stderr must not become the id): not streamed into the log
      const out = await must('creating the device', filled(cmds.create), o.runDir)
      logLine(o.log, `created the device: ${out.trim().split('\n').pop() ?? ''}`)
      if (!state.id) state.id = out.trim().split('\n').filter(Boolean).pop() ?? ''
    }
    if (!state.id) throw new Error('the device has no id: give "id" or a "create" that prints it')
    vars.id = state.id
    if (cmds.bootStays) { logLine(o.log, `booting ${state.id || 'the device'} (its output in device.log)`); state.pids.push(background(filled(cmds.boot), o.runDir, deviceLog)) }
    else await must('booting the device', filled(cmds.boot), o.runDir, o.log)
    logLine(o.log, `waiting for it to be ready (up to ${Math.round(timeout / 1000)}s)`)
    if (!(await until(async () => (await sh(filled(cmds.ready), o.runDir)).code === 0, timeout)))
      throw new Error(`device ${state.id} not ready after ${Math.round(timeout / 1000)} s:\n${existsSync(deviceLog) ? tail(readFileSync(deviceLog, 'utf8')) : '(no device log)'}`)
    logLine(o.log, `ready; Metro on :${metroPort} (its output in metro.log)`)
    state.pids.push(background(filled(o.spec.metro), o.worktree, metroLog))
    const metroUp = () => fetch(`http://127.0.0.1:${metroPort}/status`).then(r => r.text()).then(t => t.includes('packager-status:running'), () => false)
    if (!(await until(metroUp, Math.max(timeout, 60_000))))
      throw new Error(`Metro did not answer on :${metroPort}:\n${existsSync(metroLog) ? tail(readFileSync(metroLog, 'utf8')) : '(no Metro log)'}`)
    await installApp(cmds, o, filled, vars)
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
  const vars = { run: state.run, id: state.id, consolePort: state.consolePort, grpcPort: state.consolePort + 3000, metroPort: state.metroPort, runDir, template: cmds?.template }
  const headless = spec.headless && state.platform === 'android' ? '-no-window -no-audio' : ''
  const filled = (c: string) => fillSh(c.replaceAll('{headless}', headless), vars)
  if (cmds?.stop && state.id) await sh(filled(cmds.stop), runDir)
  for (const pid of livePids(state.pids)) {
    try { process.kill(-pid, 'SIGTERM') } catch {}
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
  await Bun.sleep(200)
  for (const pid of livePids(state.pids)) { try { process.kill(-pid, 'SIGKILL') } catch {} }
  if (cmds?.remove) await sh(filled(cmds.remove), runDir)
  rmSync(join(runDir, 'device.json'), { force: true })
}

/**
 * The app on the device: the build kept from an earlier run when its native inputs are the same (seconds), else
 * built (minutes) and kept for the next.
 */
async function installApp(cmds: DeviceCommands, o: { platform: string; worktree: string; log?: string; cacheDir?: string; mainCheckout?: string }, filled: (c: string) => string, vars: Record<string, string | number | undefined>) {
  if (!cmds.install) return
  const c = cmds.cache
  const key = c && o.cacheDir ? await appFingerprint(o.worktree, c.inputs, cmds.template) : undefined
  const dir = key ? join(o.cacheDir!, `${o.platform}-${key}`) : undefined
  const kept = dir && c ? join(dir, basename(c.artifact)) : undefined
  // none kept yet: the main checkout's own build, when it was built from the same native inputs
  if (kept && dir && c && !existsSync(kept) && o.mainCheckout && existsSync(join(o.mainCheckout, c.artifact)) && (await builtFromCurrent(o.mainCheckout, c)) && (await appFingerprint(o.mainCheckout, c.inputs, cmds.template)) === key) {
    mkdirSync(dir, { recursive: true })
    copyFileSync(join(o.mainCheckout, c.artifact), kept)
    logLine(o.log, `the main checkout's build has the same native inputs: kept for runs (${kept})`)
  }
  if (kept && c && existsSync(kept)) {
    logLine(o.log, `installing the app built before (its native inputs are the same): ${kept}`)
    vars.artifact = kept
    return void await must('installing the app', filled(c.installFrom), o.worktree, o.log)
  }
  await must('installing the app (build and install)', filled(cmds.install), o.worktree, o.log)
  const built = c ? join(o.worktree, c.artifact) : ''
  if (kept && dir && existsSync(built)) {
    mkdirSync(dir, { recursive: true })
    copyFileSync(built, kept)
    logLine(o.log, `kept the built app for runs with the same native inputs: ${kept}`)
    // a few per platform: the newest
    const all = readdirSync(o.cacheDir!).filter(x => x.startsWith(`${o.platform}-`)).map(x => join(o.cacheDir!, x)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    for (const old of all.slice(4)) rmSync(old, { recursive: true, force: true })
  }
}

/** the checkout's build is newer than every change to its native inputs, and none of them is modified now */
async function builtFromCurrent(checkout: string, c: { inputs: string[]; artifact: string }): Promise<boolean> {
  const git = async (...a: string[]) => { const p = Bun.spawn(['git', ...a], { cwd: checkout, stdout: 'pipe', stderr: 'ignore' }); const out = await new Response(p.stdout).text(); await p.exited; return out.trim() }
  const dirs = c.inputs.filter(i => existsSync(join(checkout, i)) && !statSync(join(checkout, i)).isFile())
  if (dirs.length && (await git('status', '--porcelain', '--', ...dirs))) return false
  const changed = Math.max(dirs.length ? Number(await git('log', '-1', '--format=%ct', '--', ...dirs)) * 1000 || 0 : 0,
    ...c.inputs.map(i => join(checkout, i)).filter(p => existsSync(p) && statSync(p).isFile()).map(p => statSync(p).mtimeMs))
  return statSync(join(checkout, c.artifact)).mtimeMs > changed
}

/** what decides a native build: each input's content (a folder's files as git sees them, changes and new files too) */
export async function appFingerprint(worktree: string, inputs: string[], template?: string): Promise<string> {
  const h = new Bun.CryptoHasher('sha256')
  h.update(`template ${template ?? ''}\n`)
  const git = async (...a: string[]) => { const p = Bun.spawn(['git', ...a], { cwd: worktree, stdout: 'pipe', stderr: 'ignore' }); const out = await new Response(p.stdout).text(); await p.exited; return out }
  for (const input of [...inputs].sort()) {
    const p = join(worktree, input)
    h.update(`input ${input}\n`)
    if (!existsSync(p)) continue
    if (statSync(p).isFile()) { h.update(readFileSync(p)); continue }
    // a folder: its tracked files as committed, what changed in them, and new files (ignored ones, builds, are not inputs)
    h.update(await git('ls-files', '-s', '--', input))
    h.update(await git('diff', '--binary', '--', input))
    for (const f of (await git('ls-files', '--others', '--exclude-standard', '--', input)).split('\n').filter(Boolean).sort()) { h.update(`new ${f}\n`); h.update(readFileSync(join(worktree, f))) }
  }
  return h.digest('hex').slice(0, 16)
}
