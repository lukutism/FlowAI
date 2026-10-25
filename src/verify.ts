import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative, resolve } from 'node:path'
import type { VerifyStep } from './config.ts'

/**
 * Checks judged against the base. The agent never commits, so its change is the worktree's uncommitted state and
 * the base is the same tree with it stashed: each step runs on both, and only findings the base doesn't have count.
 * Line numbers are left out of a finding, so code that merely moves is not new.
 */
export interface StepResult { name: string; status: 'ok' | 'new' | 'error' | 'skipped'; newFindings: string[]; head: number; base: number; note?: string }
export interface VerifyResult { ok: boolean; changed: string[]; steps: StepResult[]; note?: string }

type Run = { findings: string[] } | { error: string }

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

async function exec(cmd: string, cwd: string) {
  const p = Bun.spawn(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err }
}

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(['git', ...args], { cwd })
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) }
}

/** files the change touches, from git status (renames: the new path) */
export function changedFiles(wt: string): string[] {
  return git(wt, 'status', '--porcelain=v1', '-uall').out.split('\n').filter(Boolean)
    .map(l => l.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, '')).sort()
}

/** cwd: where the tool ran (a package of a monorepo); findings name paths from the worktree root */
function parse(step: VerifyStep, wt: string, cwd: string, r: { code: number; out: string; err: string }, json?: string): Run {
  const rel = (f: string) => relative(wt, resolve(cwd, f))
  if (step.kind === 'tsc') {
    const findings = [...r.out.matchAll(/^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/gm)].map(m => `${rel(m[1]!)}|${m[2]}|${m[3]!.trim()}`)
    return r.code !== 0 && !findings.length ? { error: `exit ${r.code}: ${(r.err || r.out).trim().split('\n').slice(-2).join(' | ')}` } : { findings }
  }
  if (step.kind === 'command') return { findings: r.code === 0 ? [] : [`${step.name}|exit ${r.code}`] }
  if (!json || !existsSync(json)) return { error: `exit ${r.code}, no report: ${(r.err || r.out).trim().split('\n').slice(-2).join(' | ') || '(no output)'}` }
  const j = JSON.parse(readFileSync(json, 'utf8') || 'null')
  if (step.kind === 'eslint')
    return { findings: (j as { filePath: string; messages: { ruleId: string | null; severity: number; message: string }[] }[])
      .flatMap(f => f.messages.filter(m => m.severity === 2).map(m => `${rel(f.filePath)}|${m.ruleId ?? 'parse'}|${m.message}`)) }
  return { findings: ((j?.testResults ?? []) as { name: string; status: string; assertionResults?: { fullName: string; status: string }[] }[]).flatMap(t => {
    const failed = (t.assertionResults ?? []).filter(a => a.status === 'failed').map(a => `${rel(t.name)}|${a.fullName}`)
    return failed.length || t.status !== 'failed' ? failed : [`${rel(t.name)}|suite failed`]
  }) }
}

async function runIn(step: VerifyStep, wt: string, cwd: string, files: string[]): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-verify-')), json = join(dir, 'report.json')
  try {
    const cmd = step.cmd.replaceAll('{files}', files.map(sh).join(' ')).replaceAll('{json}', sh(json))
    return parse(step, wt, cwd, await exec(cmd, cwd), step.cmd.includes('{json}') ? json : undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** the packages a perPackage step runs in ("packages/*": each folder there) */
function packages(wt: string, glob: string): string[] {
  const dir = glob.replace(/\/\*$/, '')
  if (!existsSync(join(wt, dir))) return []
  return readdirSync(join(wt, dir), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => `${dir}/${e.name}`).sort()
}

/** a step on files (paths from the root); per package: in each package that has some (all packages for a whole-project step) */
async function runStep(step: VerifyStep, wt: string, files: string[]): Promise<Run | null> {
  if (!step.perPackage) return step.changedOnly && !files.length ? null : runIn(step, wt, wt, files)
  const units = packages(wt, step.perPackage)
    .map(pkg => ({ pkg, files: files.filter(f => f.startsWith(`${pkg}/`)).map(f => f.slice(pkg.length + 1)) }))
    .filter(u => !step.changedOnly || u.files.length)
  if (!units.length) return null
  const runs = await Promise.all(units.map(u => runIn(step, wt, join(wt, u.pkg), u.files)))
  const errors = runs.flatMap((r, i) => ('error' in r ? [`${units[i]!.pkg}: ${r.error}`] : []))
  return errors.length ? { error: errors.join('; ') } : { findings: runs.flatMap(r => ('findings' in r ? r.findings : [])) }
}

/** head findings the base doesn't have, counting duplicates */
function newOnes(head: string[], base: string[]): string[] {
  const left = new Map<string, number>()
  for (const b of base) left.set(b, (left.get(b) ?? 0) + 1)
  return head.filter(h => { const n = left.get(h) ?? 0; if (n) { left.set(h, n - 1); return false } return true })
}

/** base findings by worktree, commit, step and files: the base doesn't change while the agent loops on its change */
const BASE = new Map<string, Run>()

export async function verify(worktree: string, steps: VerifyStep[]): Promise<VerifyResult> {
  // tools report real paths (macOS: /var is /private/var); compare against the worktree's real path
  const wt = realpathSync(worktree)
  const changed = changedFiles(wt)
  if (!changed.length) return { ok: true, changed, steps: [], note: 'no changes' }
  const filesFor = (s: VerifyStep) => (s.changedOnly ? changed.filter(f => (!s.ext || s.ext.includes(extname(f).slice(1))) && existsSync(join(wt, f))) : [])
  const todo = steps.map(s => ({ s, files: filesFor(s) }))
  const head = await Promise.all(todo.map(t => (t.s.changedOnly && !t.files.length ? null : runStep(t.s, wt, t.files))))

  // the base: the same tree with the change set aside (untracked files too), restored whatever happens. Its
  // findings depend only on the commit and the files asked about, so a later loop on the same commit reuses them.
  const headSha = git(wt, 'rev-parse', 'HEAD').out.trim()
  const atBase = todo.map(t => t.files.filter(f => git(wt, 'cat-file', '-e', `HEAD:${f}`).code === 0))
  const keys = todo.map((t, i) => `${wt}|${headSha}|${t.s.name}|${t.s.cmd}|${atBase[i]!.join(',')}`)
  const needed = todo.map((t, i) => !(t.s.changedOnly && !t.files.length) && !(t.s.changedOnly && !atBase[i]!.length) && !BASE.has(keys[i]!))
  if (needed.some(Boolean)) {
    const before = git(wt, 'rev-parse', '--verify', '--quiet', 'refs/stash').out.trim()
    const stash = git(wt, 'stash', 'push', '--include-untracked', '-m', 'flow verify: base run')
    if (stash.code !== 0) throw new Error(`could not set the change aside for the base run: ${stash.err.trim()}`)
    // never clean a tree whose change was not set aside: that would delete the agent's work
    if (git(wt, 'rev-parse', '--verify', '--quiet', 'refs/stash').out.trim() === before) throw new Error('git stash set nothing aside for the base run; verify stopped before touching the worktree')
    try {
      const runs = await Promise.all(todo.map((t, i) => (needed[i] ? runStep(t.s, wt, atBase[i]!).then(r => r ?? { findings: [] }) : null)))
      runs.forEach((r, i) => { if (r) BASE.set(keys[i]!, r) })
    } finally {
      // what the base run left (a cache file, a rewritten file) goes first: the stash holds every change of the
      // agent's, untracked files included, so anything here now is the tools' own
      git(wt, 'reset', '--quiet', '--hard')
      git(wt, 'clean', '-fdq')
      const pop = git(wt, 'stash', 'pop', '--index')
      if (pop.code !== 0) throw new Error(`the change could not be restored after the base run; it is kept in git stash (${pop.err.trim()})`)
    }
  }
  const base: (Run | null)[] = todo.map((t, i) => (t.s.changedOnly && !t.files.length ? null : t.s.changedOnly && !atBase[i]!.length ? { findings: [] } : BASE.get(keys[i]!) ?? { findings: [] }))

  const results: StepResult[] = todo.map((t, i) => {
    const h = head[i], b = base[i]
    if (!h || !b) return { name: t.s.name, status: 'ok', newFindings: [], head: 0, base: 0, note: 'no matching files' }
    if ('error' in h && 'error' in b) return { name: t.s.name, status: 'error', newFindings: [], head: 0, base: 0, note: `did not run at the base either: ${h.error}` }
    if ('error' in h) return { name: t.s.name, status: 'new', newFindings: [`${t.s.name}|did not run|${h.error}`], head: 0, base: 'findings' in b ? b.findings.length : 0 }
    const bf = 'findings' in b ? b.findings : []
    const n = newOnes(h.findings, bf)
    return { name: t.s.name, status: n.length ? 'new' : 'ok', newFindings: n, head: h.findings.length, base: bf.length, ...('error' in b ? { note: `did not run at the base: ${b.error}` } : {}) }
  })
  return { ok: results.every(r => r.status !== 'new'), changed, steps: results }
}
