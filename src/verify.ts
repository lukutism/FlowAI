import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
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

function parse(step: VerifyStep, wt: string, r: { code: number; out: string; err: string }, json?: string): Run {
  const rel = (f: string) => relative(wt, resolve(wt, f))
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

async function runStep(step: VerifyStep, wt: string, files: string[]): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-verify-')), json = join(dir, 'report.json')
  try {
    const cmd = step.cmd.replaceAll('{files}', files.map(sh).join(' ')).replaceAll('{json}', sh(json))
    return parse(step, wt, await exec(cmd, wt), step.cmd.includes('{json}') ? json : undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** head findings the base doesn't have, counting duplicates */
function newOnes(head: string[], base: string[]): string[] {
  const left = new Map<string, number>()
  for (const b of base) left.set(b, (left.get(b) ?? 0) + 1)
  return head.filter(h => { const n = left.get(h) ?? 0; if (n) { left.set(h, n - 1); return false } return true })
}

export async function verify(worktree: string, steps: VerifyStep[]): Promise<VerifyResult> {
  // tools report real paths (macOS: /var is /private/var); compare against the worktree's real path
  const wt = realpathSync(worktree)
  const changed = changedFiles(wt)
  if (!changed.length) return { ok: true, changed, steps: [], note: 'no changes' }
  const filesFor = (s: VerifyStep) => (s.changedOnly ? changed.filter(f => (!s.ext || s.ext.includes(extname(f).slice(1))) && existsSync(join(wt, f))) : [])
  const todo = steps.map(s => ({ s, files: filesFor(s) }))
  const head = await Promise.all(todo.map(t => (t.s.changedOnly && !t.files.length ? null : runStep(t.s, wt, t.files))))

  // the base: the same tree with the change set aside (untracked files too), restored whatever happens
  const stash = git(wt, 'stash', 'push', '--include-untracked', '-m', 'flow verify: base run')
  if (stash.code !== 0) throw new Error(`could not set the change aside for the base run: ${stash.err.trim()}`)
  let base: (Run | null)[]
  try {
    base = await Promise.all(todo.map(t => {
      if (t.s.changedOnly && !t.files.length) return null
      const atBase = t.files.filter(f => existsSync(join(wt, f)))
      return t.s.changedOnly && !atBase.length ? { findings: [] } : runStep(t.s, wt, atBase)
    }))
  } finally {
    const pop = git(wt, 'stash', 'pop', '--index')
    if (pop.code !== 0) throw new Error(`the change could not be restored after the base run; it is kept in git stash (${pop.err.trim()})`)
  }

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
