import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
export async function createWorktree(o: { repo: string; worktree: string; branch: string; base: string; install?: string }): Promise<{ notes: string[] }> {
  const notes: string[] = []
  const fetch = await run(['git', 'fetch', '--prune', '--quiet', 'origin'], o.repo)
  if (fetch.code !== 0) notes.push(`fetch failed, using local refs: ${tail(fetch.err, 1)}`)
  if ((await run(['git', 'rev-parse', '--verify', '--quiet', `${o.base}^{commit}`], o.repo)).code !== 0) throw new Error(`base ${o.base} not found in ${o.repo}`)
  if ((await run(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${o.branch}`], o.repo)).code === 0) throw new Error(`branch ${o.branch} exists already in ${o.repo} (another run of this ticket?)`)
  mkdirSync(dirname(o.worktree), { recursive: true })
  const add = await run(['git', 'worktree', 'add', '--quiet', '--no-track', '-b', o.branch, o.worktree, o.base], o.repo)
  if (add.code !== 0) throw new Error(`git worktree add failed: ${tail(add.err)}`)
  const nm = join(o.repo, 'node_modules')
  if (existsSync(nm)) {
    // macOS: cp -c clones the whole tree in one call (APFS clonefile); elsewhere a per-file copy-on-write copy
    const dst = join(o.worktree, 'node_modules')
    const cloned = process.platform === 'darwin' && (await run(['cp', '-c', '-R', nm, dst], o.worktree)).code === 0
    if (!cloned) {
      try { cpSync(nm, dst, { recursive: true, mode: 2 /* COPYFILE_FICLONE */, verbatimSymlinks: true }) }
      catch (e) { notes.push(`node_modules not cloned (${(e as Error).message}); the install starts from nothing`) }
    }
  }
  if (o.install) {
    const i = await run(['sh', '-c', o.install], o.worktree)
    if (i.code !== 0) throw new Error(`install failed (${o.install}):\n${tail(i.err || i.out)}`)
  }
  return { notes }
}

/**
 * flow's ship step: the agent's uncommitted change becomes one commit (commit hooks run as usual) and the branch
 * is pushed. Never forced: a branch that moved on origin makes the push fail instead. Safe to do again: a clean
 * worktree (committed by an earlier try whose push failed) is only pushed.
 */
export async function shipChange(o: { worktree: string; branch: string; message: string; env?: Env }): Promise<{ files: string[] }> {
  const files = changedFiles(o.worktree)
  if (files.length) {
    const add = await run(['git', 'add', '--all'], o.worktree, o.env)
    if (add.code !== 0) throw new Error(`git add failed: ${tail(add.err)}`)
    const commit = await run(['git', 'commit', '--quiet', '-m', o.message], o.worktree, o.env)
    if (commit.code !== 0) {
      await run(['git', 'reset', '--quiet'], o.worktree, o.env) // unstage again: the change stays as the agent left it
      throw new Error(`commit refused:\n${tail(commit.err || commit.out)}`)
    }
  }
  const push = await run(['git', 'push', '--quiet', '-u', 'origin', `HEAD:refs/heads/${o.branch}`], o.worktree, o.env)
  if (push.code !== 0) throw new Error(`push failed: ${tail(push.err)}`)
  return { files }
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
