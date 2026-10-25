import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentHash, createWorktree, pending, shipChange } from '../src/git.ts'

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...a: string[]) => { const r = Bun.spawnSync(['git', ...a], { cwd, env }); return new TextDecoder().decode(r.stdout).trim() }

/** an origin with develop and a release line, and the user's main checkout with node_modules installed */
function project() {
  const root = mkdtempSync(join(tmpdir(), 'flow-git-'))
  const origin = join(root, 'origin.git'), main = join(root, 'main')
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'develop', origin])
  Bun.spawnSync(['git', 'clone', '-q', origin, main], { env })
  writeFileSync(join(main, 'a.ts'), 'develop\n'); writeFileSync(join(main, '.gitignore'), 'node_modules/\n')
  git(main, 'add', '.'); git(main, 'commit', '-qm', 'develop'); git(main, 'push', '-q', 'origin', 'HEAD:develop')
  git(main, 'checkout', '-qb', 'patch/3.20.7'); writeFileSync(join(main, 'a.ts'), 'release\n')
  git(main, 'commit', '-qam', 'release'); git(main, 'push', '-q', 'origin', 'patch/3.20.7'); git(main, 'checkout', '-q', 'develop')
  mkdirSync(join(main, 'node_modules', 'left-pad'), { recursive: true }); writeFileSync(join(main, 'node_modules', 'left-pad', 'index.js'), 'x')
  return { root, origin, main, wt: join(root, 'worktrees', '186278', 'mobile') }
}

describe('createWorktree: the run\'s own checkout on its own branch', () => {
  test('from the chosen base (a release line), node_modules cloned from the main checkout, then the install', async () => {
    const p = project()
    const r = await createWorktree({ repo: p.main, worktree: p.wt, branch: 'fix/186278', base: 'origin/patch/3.20.7', install: 'touch installed' })
    expect(r.notes).toEqual([])
    expect(readFileSync(join(p.wt, 'a.ts'), 'utf8')).toBe('release\n')
    expect(git(p.wt, 'branch', '--show-current')).toBe('fix/186278')
    expect(existsSync(join(p.wt, 'node_modules', 'left-pad', 'index.js'))).toBe(true)
    expect(existsSync(join(p.wt, 'installed'))).toBe(true)
  })
  test('a base that does not exist is refused, naming it', async () => {
    const p = project()
    await expect(createWorktree({ repo: p.main, worktree: p.wt, branch: 'fix/1', base: 'origin/patch/9.9.9' })).rejects.toThrow(/origin\/patch\/9\.9\.9 not found/)
  })
  test('a branch that exists already (another run of this ticket) is refused rather than reused', async () => {
    const p = project()
    git(p.main, 'branch', 'fix/1')
    await expect(createWorktree({ repo: p.main, worktree: p.wt, branch: 'fix/1', base: 'origin/develop' })).rejects.toThrow(/branch fix\/1 exists/)
  })
  test('a failing install is an error with its output', async () => {
    const p = project()
    await expect(createWorktree({ repo: p.main, worktree: p.wt, branch: 'fix/2', base: 'origin/develop', install: 'echo lockfile mismatch >&2; exit 1' })).rejects.toThrow(/install failed.*lockfile mismatch/s)
  })
})

describe('shipChange: flow\'s own commit and push of the agent\'s uncommitted change', () => {
  test('everything in the worktree becomes one commit with the message, pushed to the branch on origin', async () => {
    const p = project()
    await createWorktree({ repo: p.main, worktree: p.wt, branch: 'fix/186278', base: 'origin/develop' })
    writeFileSync(join(p.wt, 'a.ts'), 'fixed\n'); writeFileSync(join(p.wt, 'b.ts'), 'new\n')
    const r = await shipChange({ worktree: p.wt, branch: 'fix/186278', message: 'fix(mobile): #186278 Fix it', env })
    expect(r.files).toEqual(['a.ts', 'b.ts'])
    expect(git(p.origin, 'log', '-1', '--format=%s', 'fix/186278')).toBe('fix(mobile): #186278 Fix it')
    expect(git(p.origin, 'show', 'fix/186278:a.ts')).toBe('fixed')
  })
  test('node_modules (cloned in, ignored) is never committed', async () => {
    const p = project()
    await createWorktree({ repo: p.main, worktree: p.wt, branch: 'fix/3', base: 'origin/develop' })
    writeFileSync(join(p.wt, 'a.ts'), 'fixed\n')
    expect((await shipChange({ worktree: p.wt, branch: 'fix/3', message: 'fix: x', env })).files).toEqual(['a.ts'])
  })
  test('a commit hook refusing the commit stops the ship with the hook\'s words; nothing is pushed', async () => {
    const p = project()
    await createWorktree({ repo: p.main, worktree: p.wt, branch: 'fix/4', base: 'origin/develop' })
    const hooks = join(p.root, 'hooks'); mkdirSync(hooks)
    writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\necho "subject may not end with full stop" >&2\nexit 1\n', { mode: 0o755 })
    git(p.wt, 'config', 'core.hooksPath', hooks)
    writeFileSync(join(p.wt, 'a.ts'), 'fixed\n')
    await expect(shipChange({ worktree: p.wt, branch: 'fix/4', message: 'fix: x.', env })).rejects.toThrow(/commit refused.*full stop/s)
    expect(git(p.origin, 'branch', '--list', 'fix/4')).toBe('')
    // the change is left as the agent left it: modified, not staged
    expect(git(p.wt, 'diff', '--cached', '--name-only')).toBe('')
    expect(git(p.wt, 'diff', '--name-only')).toBe('a.ts')
  })
  test('nothing uncommitted (an earlier try committed, then its push failed): no new commit, just the push', async () => {
    const p = project()
    await createWorktree({ repo: p.main, worktree: p.wt, branch: 'fix/5', base: 'origin/develop' })
    const head = () => new TextDecoder().decode(Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: p.wt }).stdout).trim()
    const before = head()
    expect(await shipChange({ worktree: p.wt, branch: 'fix/5', message: 'fix: x', env })).toEqual({ files: [] })
    expect(head()).toBe(before)
    expect(await pending(p.wt, 'origin/develop')).toBe(false)
  })
  test('the content hash: the same for the same files, different after any change (untracked too); git\'s index untouched', async () => {
    const p = project()
    await createWorktree({ repo: p.main, worktree: p.wt, branch: 'fix/6', base: 'origin/develop' })
    const a = await contentHash(p.wt)
    expect(a).toMatch(/^[0-9a-f]{40}$/)
    expect(await contentHash(p.wt)).toBe(a)
    writeFileSync(join(p.wt, 'new.txt'), 'x\n')
    const b = await contentHash(p.wt)
    expect(b).not.toBe(a)
    expect(new TextDecoder().decode(Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: p.wt }).stdout)).toBe('?? new.txt\n')
    expect(await pending(p.wt, 'origin/develop')).toBe(true)
  })
})
