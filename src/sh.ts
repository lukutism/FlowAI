/** A project's shell commands: {placeholders} filled in, run with sh in a folder. */
import { appendFileSync, closeSync, openSync, readFileSync, statSync } from 'node:fs'

/** {name} → its value; unknown names stay as written */
export const fill = (cmd: string, vars: Record<string, string | number | undefined>) => cmd.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined ? m : String(vars[k])))
/** a value as one shell word: plain ones as they are, others single-quoted; empty is no word */
const word = (v: string) => (v === '' || /^[\w./:=@+,%-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`)
/** {name} → its value as one shell word (values come from tickets and forms); unknown names stay as written */
export const fillSh = (cmd: string, vars: Record<string, string | number | undefined>) => cmd.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined ? m : word(String(vars[k]))))
/** the process ids in a run's state file that are safe to signal: never 0, 1 or negative (kill(-1) is everything) */
export const livePids = (pids: unknown): number[] => (Array.isArray(pids) ? pids : []).filter((p): p is number => Number.isInteger(p) && p > 1)
export const tail = (s: string, n = 5) => s.trim().split('\n').slice(-n).join('\n')

export async function sh(cmd: string, cwd: string, env?: Record<string, string | undefined>) {
  const p = Bun.spawn(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', ...(env ? { env } : {}) })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err }
}

/** a line in a run's setup log, with the time */
export function logLine(log: string | undefined, text: string) {
  if (!log) return
  const t = new Date(), two = (n: number) => String(n).padStart(2, '0')
  appendFileSync(log, `${two(t.getHours())}:${two(t.getMinutes())}:${two(t.getSeconds())} ${text}\n`)
}

/** a command whose output goes into the log as it comes (an install, an app build); its last lines when it fails */
export async function shLogged(cmd: string, cwd: string, log: string, env?: Record<string, string | undefined>): Promise<{ code: number; out: string }> {
  logLine(log, `$ ${cmd}`)
  const start = statSync(log).size
  const fd = openSync(log, 'a')
  const p = Bun.spawn(['sh', '-c', cmd], { cwd, stdout: fd, stderr: fd, ...(env ? { env } : {}) })
  const code = await p.exited
  closeSync(fd)
  const out = readFileSync(log, 'utf8').slice(start)
  return { code, out }
}
