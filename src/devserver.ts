import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { background, canBind, freePort, until } from './device.ts'
import { fill, tail } from './sh.ts'

/**
 * A run's own dev server (a web app's): the repo's command on a free port, in the background in its own process
 * group, its output in devserver.log; ready once something listens on the port. Placeholders: {port}, {run},
 * {worktree}, {runDir}.
 */
export interface DevServerState { run: string; repo: string; port: number; url: string; pids: number[] }

export async function startDevServer(o: { run: string; repo: string; cmd: string; portStart: number; url: string; runDir: string; worktree: string; taken?: Set<number>; readyTimeoutMs?: number }): Promise<DevServerState> {
  const port = await freePort(o.portStart, 1, o.taken)
  const vars = { port, run: o.run, worktree: o.worktree, runDir: o.runDir }
  const log = join(o.runDir, 'devserver.log')
  const state: DevServerState = { run: o.run, repo: o.repo, port, url: fill(o.url, vars), pids: [] }
  state.pids.push(background(fill(o.cmd, vars), o.worktree, log))
  const timeout = o.readyTimeoutMs ?? 300_000
  if (!(await until(async () => !canBind(port), timeout))) {
    await stopDevServer(state, o.runDir)
    throw new Error(`not listening on :${port} after ${Math.round(timeout / 1000)} s:\n${existsSync(log) ? tail(readFileSync(log, 'utf8')) : '(no log)'}`)
  }
  writeFileSync(join(o.runDir, 'devserver.json'), JSON.stringify(state, null, 2) + '\n')
  return state
}

export async function stopDevServer(state: DevServerState, runDir: string) {
  for (const pid of state.pids) { try { process.kill(-pid, 'SIGTERM') } catch {} try { process.kill(pid, 'SIGTERM') } catch {} }
  await Bun.sleep(200)
  for (const pid of state.pids) { try { process.kill(-pid, 'SIGKILL') } catch {} }
  rmSync(join(runDir, 'devserver.json'), { force: true })
}
