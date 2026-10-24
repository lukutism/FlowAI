import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
    try { cpSync(nm, join(o.worktree, 'node_modules'), { recursive: true, mode: 2 /* COPYFILE_FICLONE: clone where the disk can */, verbatimSymlinks: true }) }
    catch (e) { notes.push(`node_modules not cloned (${(e as Error).message}); the install starts from nothing`) }
  }
  if (o.install) {
    const i = await run(['sh', '-c', o.install], o.worktree)
    if (i.code !== 0) throw new Error(`install failed (${o.install}):\n${tail(i.err || i.out)}`)
  }
  return { notes }
}

/**
 * flow's ship step: the agent's uncommitted change becomes one commit (commit hooks run as usual) and the branch
 * is pushed. Never forced: a branch that moved on origin makes the push fail instead.
 */
export async function shipChange(o: { worktree: string; branch: string; message: string; env?: Env }): Promise<{ files: string[] }> {
  const files = changedFiles(o.worktree)
  if (!files.length) throw new Error('nothing to ship: the worktree has no changes')
  const add = await run(['git', 'add', '--all'], o.worktree, o.env)
  if (add.code !== 0) throw new Error(`git add failed: ${tail(add.err)}`)
  const commit = await run(['git', 'commit', '--quiet', '-m', o.message], o.worktree, o.env)
  if (commit.code !== 0) {
    await run(['git', 'reset', '--quiet'], o.worktree, o.env) // unstage again: the change stays as the agent left it
    throw new Error(`commit refused:\n${tail(commit.err || commit.out)}`)
  }
  const push = await run(['git', 'push', '--quiet', '-u', 'origin', `HEAD:refs/heads/${o.branch}`], o.worktree, o.env)
  if (push.code !== 0) throw new Error(`push failed: ${tail(push.err)}`)
  return { files }
}
