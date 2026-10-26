/**
 * Only the fix, and nothing that shouldn't be published (hwt's PR checks): what the change adds beyond what the
 * plan's PR extras allow (tests and comments reviewers took out of most PRs), suppressions, local paths and env
 * files; and what the PR description says (its proof lines, no local paths, no agent). Findings are
 * file|rule|message, like verify's: they go to the agent in the fix loop, and ship needs a clean verify.
 * The change is the worktree against HEAD, so a customer patch committed under it is not the agent's.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CODE = /\.[cm]?[jt]sx?$/
const isTest = (f: string) => /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /(^|\/)jest\.config\.[\w.]+$/.test(f)
const SUPPRESSION = /@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|\b(?:it|test|describe)\.(?:skip|only)\(|\b(?:xit|xtest|xdescribe|fit|fdescribe)\(/
const localPath = (t: string) => t.includes(homedir()) || /(^|[\s'"`(=])\/(Users|home)\/[a-z][\w.-]*\/|\/private\/tmp\/|\/var\/folders\//.test(t)
/** a comment line, or a comment after code (strings blanked first) */
const isComment = (t: string) => /^\s*(\/\/|\/\*|\*(?![\w*])|\{\s*\/\*)/.test(t) || /\s\/\/|\/\*/.test(t.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""'))

async function git(cwd: string, ...args: string[]) {
  const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(p.stdout).text()
  await p.exited
  return out
}

/** what the worktree adds against HEAD (tracked changes and new files) beyond what PR extras allow */
export async function drift(worktree: string, extras: { tests: boolean; comments: boolean }): Promise<string[]> {
  const out: string[] = []
  const status = (await git(worktree, 'status', '--porcelain', '--untracked-files=all')).split('\n').filter(Boolean)
  const untracked = status.filter(l => l.startsWith('??')).map(l => l.slice(3)).filter(f => existsSync(join(worktree, f)) && !lstatSync(join(worktree, f)).isSymbolicLink())
  const edited = status.filter(l => !l.startsWith('??')).map(l => l.slice(3).replace(/^.* -> /, ''))
  // added lines per file, with their line numbers
  const added = new Map<string, { n: number; t: string }[]>()
  let file = '', n = 0
  for (const l of (await git(worktree, 'diff', '-U0', '--no-color', 'HEAD')).split('\n')) {
    if (l.startsWith('+++ ')) { file = l.replace(/^\+\+\+ (b\/)?/, ''); continue }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l)
    if (h) { n = Number(h[1]); continue }
    if (l.startsWith('+') && file !== '/dev/null') { (added.get(file) ?? added.set(file, []).get(file)!).push({ n, t: l.slice(1) }); n++ }
  }
  for (const f of untracked) {
    let text = ''
    try { text = readFileSync(join(worktree, f), 'utf8') } catch {}
    if (text.includes('\0')) continue
    added.set(f, text.replace(/\n$/, '').split('\n').map((t, i) => ({ n: i + 1, t })))
  }
  for (const [f, lines] of [...added].sort(([a], [b]) => a.localeCompare(b))) {
    const path = lines.find(l => localPath(l.t))
    if (path) out.push(`${f}:${path.n}|leak|a local path (${path.t.trim().slice(0, 60)}): it would be published; remove it`)
    if (!CODE.test(f)) continue
    for (const l of lines) if (SUPPRESSION.test(l.t)) out.push(`${f}:${l.n}|suppression|${l.t.trim().slice(0, 80)}: fix the cause instead of suppressing it`)
    const comments = isTest(f) ? [] : lines.filter(l => isComment(l.t))
    if (comments.length && !extras.comments) out.push(`${f}|comments|${comments.length} new comment line${comments.length === 1 ? '' : 's'} (${comments.map(c => c.n).join(', ')}): the PR description explains the change; remove ${comments.length === 1 ? 'it' : 'them'}, or put "PR extras: comments — <who asked>" in the plan`)
  }
  if (!extras.tests) {
    for (const f of untracked.filter(isTest)) out.push(`${f}|tests|a new test file nobody asked for in the PR: move it to the run's tests/ folder and name it in a Verified: line, or put "PR extras: tests — <who asked>" in the plan`)
    for (const f of edited.filter(isTest)) out.push(`${f}|tests|an edited test file: fix the code, not the test (restore it), or put "PR extras: tests — <who asked>" in the plan`)
  }
  // templates (.env.example …) are part of a change; a real env file is the developer's own setup
  for (const f of edited.filter(f => /(^|\/)\.env[^/]*$/.test(f) && !/\.(example|sample|template|dist)$/.test(f))) out.push(`${f}|leak|an env file is local setup, not part of the change: restore it`)
  return out
}

/** what the PR description (pr.md) says that a reviewer can't take, or the team shouldn't read */
export function prProblems(pr: string, o: { repro?: string; evidence: string[] }): string[] {
  const out: string[] = []
  if (!/^\s*(?:-\s*)?Verified:\s*\S/m.test(pr)) out.push('pr.md|proof|add a "Verified: <command> → <result>" line for each check you ran')
  if (!/^\s*(?:-\s*)?Not verified:\s*\S/m.test(pr)) out.push('pr.md|proof|add a "Not verified: <what and why, or nothing>" line')
  if (localPath(pr)) out.push('pr.md|leak|a local path: the description is published as written; remove it')
  if (/\bclaude\b|\b(ai|coding) agent\b|\bagent (wrote|found|opened|made|changed)\b|\bflow (run|agent)\b/i.test(pr)) out.push('pr.md|leak|the agent or its tools are named: the description is published as the developer\'s own text; rewrite it without them')
  if (o.repro === 'live' && !o.evidence.some(f => /^before-/.test(f))) out.push('evidence|repro|Repro: live needs its before-screenshot in the run\'s evidence/before-*.png: take it, or set Repro to what you actually did')
  return out
}
