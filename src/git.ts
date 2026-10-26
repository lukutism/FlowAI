import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { logLine, shLogged } from './sh.ts'
import { changedFiles } from './verify.ts'

type Env = Record<string, string | undefined>

async function run(cmd: string[], cwd: string, env?: Env) {
  const p = Bun.spawn(cmd, { cwd, env: env ?? process.env, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out: out.trim(), err: err.trim() }
}
const tail = (s: string, n = 6) => s.split('\n').slice(-n).join('\n')

/**
 * The run's own git worktree on a new branch from its base. node_modules is cloned from the user's main checkout
 * (copy-on-write on APFS, so instant and separate), then the project's install brings it in line with the base.
 */
export async function createWorktree(o: { repo: string; worktree: string; branch: string; base: string; install?: string; localFiles?: string[]; ignore?: string[]; log?: string; indexes?: { dir: string; sync?: string }[] }): Promise<{ notes: string[] }> {
  const notes: string[] = []
  const started = Date.now(), secs = (t: number) => `${Math.round((Date.now() - t) / 1000)}s`
  logLine(o.log, `fetching origin in ${o.repo}`)
  const fetch = await run(['git', 'fetch', '--prune', '--quiet', 'origin'], o.repo)
  if (fetch.code !== 0) notes.push(`fetch failed, using local refs: ${tail(fetch.err, 1)}`)
  if ((await run(['git', 'rev-parse', '--verify', '--quiet', `${o.base}^{commit}`], o.repo)).code !== 0) throw new Error(`base ${o.base} not found in ${o.repo}`)
  if ((await run(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${o.branch}`], o.repo)).code === 0) throw new Error(`branch ${o.branch} exists already in ${o.repo} (another run of this ticket?)`)
  logLine(o.log, `worktree ${o.worktree} on ${o.branch}, from ${o.base}`)
  mkdirSync(dirname(o.worktree), { recursive: true })
  const add = await run(['git', 'worktree', 'add', '--quiet', '--no-track', '-b', o.branch, o.worktree, o.base], o.repo)
  if (add.code !== 0) {
    // git makes the branch before the checkout: one it made for a worktree that isn't there goes too (it didn't exist above)
    await run(['git', 'worktree', 'prune'], o.repo)
    await run(['git', 'branch', '-D', o.branch], o.repo)
    throw new Error(`git worktree add failed: ${tail(add.err)}`)
  }
  // what tools write into a worktree (argent's .argent/) stays out of the change: git's local exclude list
  const indexes = (o.indexes ?? []).filter(x => existsSync(join(o.repo, x.dir)))
  const ignore = [...(o.ignore ?? []), ...indexes.map(x => `/${x.dir.replace(/\/$/, '')}/`)]
  if (ignore.length) {
    const ex = resolve(o.worktree, (await run(['git', 'rev-parse', '--git-path', 'info/exclude'], o.worktree)).out)
    const have = existsSync(ex) ? readFileSync(ex, 'utf8') : ''
    const add = ignore.filter(p => !have.split('\n').includes(p))
    if (add.length) { mkdirSync(dirname(ex), { recursive: true }); writeFileSync(ex, `${have}${have && !have.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`) }
  }
  // an index (a code graph) is the run's own copy: the main checkout's indexes another line, and a sync from the
  // worktree must not write into it; cloned copy-on-write, then brought up to this branch in the background
  const own = new Set((o.indexes ?? []).map(x => x.dir.replace(/\/$/, '')))
  const linked = await linkLocal(o.repo, o.worktree, (o.localFiles ?? []).filter(f => !own.has(f.replace(/\/$/, ''))))
  if (linked.length) notes.push(`linked ${linked.join(', ')} from the main checkout`)
  for (const x of indexes) {
    const src = join(o.repo, x.dir), dst = join(o.worktree, x.dir)
    if (existsSync(dst)) continue // tracked on this branch
    const cloned = cloneTree(src, dst) || (process.platform === 'darwin' && (await run(['cp', '-c', '-R', src, dst], o.worktree)).code === 0)
    if (!cloned) { try { cpSync(src, dst, { recursive: true, mode: 2 /* COPYFILE_FICLONE */ }) } catch (e) { notes.push(`${x.dir} not copied: ${(e as Error).message}`); continue } }
    logLine(o.log, `${x.dir}: copied from the main checkout${x.sync ? `; ${x.sync} in the background` : ''}`)
    if (x.sync) {
      const out = o.log ? `>> '${o.log.replace(/'/g, `'\\''`)}' 2>&1` : '>/dev/null 2>&1'
      Bun.spawn(['sh', '-c', `(${x.sync}) ${out} &`], { cwd: o.worktree, stdout: 'ignore', stderr: 'ignore', env: process.env })
    }
  }
  const nm = join(o.repo, 'node_modules')
  if (existsSync(nm)) {
    const t = Date.now()
    logLine(o.log, 'node_modules: cloning the main checkout\'s (copy-on-write)')
    // macOS: the whole folder cloned in one call (APFS clonefile: ~2 s for 120k files, where cp -c takes ~25 s);
    // else cp -c file by file; elsewhere a per-file copy-on-write copy
    const dst = join(o.worktree, 'node_modules')
    const cloned = cloneTree(nm, dst) || (process.platform === 'darwin' && (await run(['cp', '-c', '-R', nm, dst], o.worktree)).code === 0)
    if (!cloned) {
      try { cpSync(nm, dst, { recursive: true, mode: 2 /* COPYFILE_FICLONE */, verbatimSymlinks: true }) }
      catch (e) { notes.push(`node_modules not cloned (${(e as Error).message}); the install starts from nothing`) }
    }
    logLine(o.log, `node_modules cloned in ${secs(t)}`)
  }
  if (o.install) {
    const t = Date.now()
    logLine(o.log, 'install')
    const i = o.log ? await shLogged(o.install, o.worktree, o.log) : await run(['sh', '-c', o.install], o.worktree).then(r => ({ code: r.code, out: r.err || r.out }))
    if (i.code !== 0) { logLine(o.log, `install failed after ${secs(t)}`); throw new Error(`install failed (${o.install}):\n${tail(i.out)}`) }
    logLine(o.log, `installed in ${secs(t)}`)
  }
  logLine(o.log, `${o.worktree} ready in ${secs(started)}`)
  return { notes }
}

/**
 * flow's ship step: the agent's uncommitted change becomes one commit (commit hooks run as usual) and the branch
 * is pushed. Never forced: a branch that moved on origin makes the push fail instead. Safe to do again: a clean
 * worktree (committed by an earlier try whose push failed) is only pushed.
 */
/**
 * A hook's terminal output as plain lines: colour codes, cursor moves and spinners out, the last few lines that say
 * something.
 */
export function plainOutput(text: string, lines = 8): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\u2800-\u28ff]/g, '').split(/\r?\n|\r/).map(l => l.trimEnd()).filter(l => l.trim() && !/^[\s─━-]+$/.test(l)).slice(-lines).join('\n')
}

/** the hook's objection is a lint report and nothing else: no commit-message check, no secret scan (hwt's rule) */
export const lintOnly = (out: string) => /\beslint\b|\blint\b|\d+ problems? \(/i.test(out)
  && !/commitlint|commit-msg|gitleaks|detect-secrets|trufflehog|secretlint|talisman|secrets? (found|detected)|potential secret/i.test(out)

/**
 * verified: verify found nothing new for exactly this tree. A commit hook that lints whole touched files then only
 * objects to lint they already had: flow commits past it (the developer's rule, as in hwt), and checks its own
 * message with the repo's commitlint, which --no-verify skips too. Any other objection stops the ship.
 */
export async function shipChange(o: { worktree: string; branch: string; message: string; env?: Env; verified?: boolean }): Promise<{ files: string[]; bypassed?: string }> {
  const files = changedFiles(o.worktree)
  let bypassed: string | undefined
  if (files.length) {
    const add = await run(['git', 'add', '--all'], o.worktree, o.env)
    if (add.code !== 0) throw new Error(`git add failed: ${tail(add.err)}`)
    const commit = await run(['git', 'commit', '--quiet', '-m', o.message], o.worktree, o.env)
    if (commit.code !== 0) {
      const said = plainOutput(`${commit.out}\n${commit.err}`)
      if (o.verified && lintOnly(said)) {
        const forced = await run(['git', 'commit', '--quiet', '--no-verify', '-m', o.message], o.worktree, o.env)
        if (forced.code !== 0) { await run(['git', 'reset', '--quiet'], o.worktree, o.env); throw new Error(`commit refused:\n${plainOutput(forced.err || forced.out)}`) }
        const cl = await commitlintProblem(o.worktree, o.message, o.env)
        if (cl) {
          await run(['git', 'reset', '--quiet', '--soft', 'HEAD~1'], o.worktree, o.env); await run(['git', 'reset', '--quiet'], o.worktree, o.env)
          throw new Error(`the commit message flow wrote fails the repo's commitlint (flow's format, not the change):\n${cl}`)
        }
        bypassed = "committed past the commit hook: it objected only to lint the touched files already had (verify found nothing new)"
      } else {
        await run(['git', 'reset', '--quiet'], o.worktree, o.env) // unstage again: the change stays as the agent left it
        throw new Error(`commit refused by the repo's hooks:\n${said}`)
      }
    }
  }
  const push = await run(['git', 'push', '--quiet', '-u', 'origin', `HEAD:refs/heads/${o.branch}`], o.worktree, o.env)
  if (push.code !== 0) throw new Error(`push failed: ${tail(push.err)}`)
  return { files, ...(bypassed ? { bypassed } : {}) }
}

/** the repo's commitlint on a message (null: fine, or the repo has none) */
async function commitlintProblem(worktree: string, message: string, env?: Env): Promise<string | null> {
  const configured = readdirSync(worktree).some(f => /^(commitlint\.config\.[cm]?[jt]s|\.commitlintrc(\.\w+)?)$/.test(f))
    || (existsSync(join(worktree, 'package.json')) && /"commitlint"\s*:/.test(readFileSync(join(worktree, 'package.json'), 'utf8')))
  if (!configured) return null
  const p = Bun.spawn(['npx', '--no-install', 'commitlint'], { cwd: worktree, stdin: new Blob([message]), stdout: 'pipe', stderr: 'pipe', env: env ?? process.env })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return (await p.exited) === 0 ? null : plainOutput(out + err)
}

/** what a worktree has to ship: uncommitted changes, or commits of its own on top of its base */
export async function pending(worktree: string, base: string): Promise<boolean> {
  if (changedFiles(worktree).length) return true
  const r = await run(['git', 'rev-list', '--count', `${base}..HEAD`], worktree)
  return r.code === 0 && Number(r.out) > 0
}

/** whether the branch on origin is at the worktree's HEAD (after flow's own push) */
export async function pushed(worktree: string, branch: string): Promise<boolean> {
  const [head, remote] = await Promise.all([run(['git', 'rev-parse', 'HEAD'], worktree), run(['git', 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], worktree)])
  return remote.code === 0 && head.out === remote.out
}

/**
 * The worktree's content as one hash: HEAD plus every change, untracked files too (what verify saw). It works on
 * a copy of the index, so git's own index is untouched and only changed files are hashed again.
 */
export async function contentHash(worktree: string): Promise<string> {
  const idx = (await run(['git', 'rev-parse', '--git-path', 'index'], worktree)).out
  const tmp = join(tmpdir(), `flow-index-${process.pid}-${Math.random().toString(36).slice(2)}`)
  try {
    const src = resolve(worktree, idx)
    if (existsSync(src)) copyFileSync(src, tmp)
    const env = { ...process.env, GIT_INDEX_FILE: tmp }
    const add = await run(['git', 'add', '--all'], worktree, env)
    const tree = await run(['git', 'write-tree'], worktree, env)
    return add.code === 0 && tree.code === 0 ? tree.out : ''
  } finally { rmSync(tmp, { force: true }) }
}

/**
 * The main checkout's local files git ignores (project skills, .mcp.json, registry auth, a code index) linked into
 * the worktree, so its agent has the same setup. Only ignored ones: anything else would be shipped. A folder the
 * repo tracks gets its missing ignored entries one by one. Links point out of the worktree, so the guard and the
 * sandbox keep the agent from writing through them.
 */
async function linkLocal(repo: string, worktree: string, names: string[]): Promise<string[]> {
  const out: string[] = []
  const ignored = async (rel: string) => (await run(['git', 'check-ignore', '-q', '--no-index', rel], worktree)).code === 0
  const one = async (rel: string) => {
    const src = join(repo, rel), dst = join(worktree, rel)
    if (!existsSync(src)) return
    if (existsSync(dst)) {
      if (statSync(dst).isDirectory() && statSync(src).isDirectory()) for (const c of readdirSync(src).sort()) await one(join(rel, c))
      return
    }
    // a folder is asked about as one (a rule like skills/ matches only folders, and it isn't in the worktree yet)
    if (!(await ignored(statSync(src).isDirectory() ? `${rel}/` : rel))) return
    mkdirSync(dirname(dst), { recursive: true })
    symlinkSync(src, dst)
    out.push(rel)
  }
  for (const n of names) await one(n)
  return out
}

/**
 * A folder cloned whole in one call (macOS APFS clonefile): copy-on-write, no extra disk until either side writes.
 * false when it can't be (another platform or volume, the target there already): the caller copies another way.
 */
export function cloneTree(src: string, dst: string): boolean {
  if (process.platform !== 'darwin' || existsSync(dst)) return false
  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi')
    const lib = dlopen('/usr/lib/libSystem.B.dylib', { clonefile: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } })
    try { return lib.symbols.clonefile(ptr(Buffer.from(`${src}\0`)), ptr(Buffer.from(`${dst}\0`)), 0) === 0 } finally { lib.close() }
  } catch { return false }
}
