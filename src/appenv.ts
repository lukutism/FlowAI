/**
 * A run's app environment: the repo's env file (an app's .env) written into the worktree with the run's own values,
 * the project's fixed ones and the license from the login step, so the app on the run's device can sign in. The
 * file is the run's own: a link to the main checkout's is replaced, never written through.
 */
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface AppEnv {
  /** the file the app reads, relative to the worktree */
  file: string
  /** the file it starts from (the repo's template); without one, the file as the worktree has it */
  from?: string
  /** fixed values for every run */
  set: Record<string, string>
  /** which variable gets which value from the login step */
  login: { email?: string; password?: string; license?: string }
}

export type Logins = { email?: string; password?: string; license?: string }

/** the login step's text (`email: …` a line) by name */
export function parseLogins(text: string): Logins {
  const out: Logins = {}
  for (const line of text.split('\n')) {
    const m = /^(email|password|license):\s*(.*?)\s*$/.exec(line)
    if (m && m[2]) out[m[1] as keyof Logins] = m[2]
  }
  return out
}

/** the given keys replaced in place; everything else (comments, order) stays; missing keys are appended */
export function renderEnv(base: string, values: Record<string, string>): string {
  const left = { ...values }
  const lines = base.replace(/\n$/, '').split('\n').filter((l, i, a) => l || i < a.length - 1).map(line => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)
    if (!m || !(m[1]! in left)) return line
    const v = left[m[1]!]!
    delete left[m[1]!]
    return `${m[1]}=${v}`
  })
  return [...lines, ...Object.entries(left).map(([k, v]) => `${k}=${v}`)].join('\n') + '\n'
}

/** the run's env file written; what was set, by name only (for the setup log), or undefined when nothing was */
export function writeAppEnv(worktree: string, spec: AppEnv, logins: Logins): string | undefined {
  const values: Record<string, string> = { ...spec.set }
  for (const k of ['email', 'password', 'license'] as const) if (spec.login[k] && logins[k]) values[spec.login[k]!] = logins[k]!
  if (!Object.keys(values).length) return undefined
  const out = join(worktree, spec.file), from = join(worktree, spec.from ?? spec.file)
  if (!existsSync(from)) throw new Error(`app env: ${spec.from ?? spec.file} not found in the worktree`)
  const base = readFileSync(from, 'utf8')
  // a link (localFiles) points at the main checkout's file: the run gets a file of its own instead
  if (isLink(out)) rmSync(out)
  writeFileSync(out, renderEnv(base, values), { mode: 0o600 })
  return `${spec.file}: ${Object.keys(values).sort().join(', ')} set for this run`
}

const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink() } catch { return false } }
