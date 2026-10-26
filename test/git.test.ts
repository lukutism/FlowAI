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

describe('createWorktree: the main checkout\'s local files the agent needs', () => {
  test('ignored local files (skills, MCP servers, registry auth) are linked in; a tracked folder gets its missing ignored entries; nothing tracked or unignored is touched', async () => {
    const p = project()
    writeFileSync(join(p.main, '.gitignore'), 'node_modules/\n.mcp.json\n.npmrc\n.claude/skills/\n.claude/settings.local.json\n')
    mkdirSync(join(p.main, '.claude', 'commands'), { recursive: true }); writeFileSync(join(p.main, '.claude', 'commands', 'a.md'), 'tracked\n')
    git(p.main, 'add', '.'); git(p.main, 'add', '-f', '.claude/commands/a.md'); git(p.main, 'commit', '-qm', 'claude'); git(p.main, 'push', '-q', 'origin', 'HEAD:develop')
    mkdirSync(join(p.main, '.claude', 'skills', 'ui'), { recursive: true }); writeFileSync(join(p.main, '.claude', 'skills', 'ui', 'SKILL.md'), 'skill\n')
    writeFileSync(join(p.main, '.claude', 'settings.local.json'), '{}\n'); writeFileSync(join(p.main, '.mcp.json'), '{}\n'); writeFileSync(join(p.main, 'notes.txt'), 'not ignored\n')
    const r = await createWorktree({ repo: p.main, worktree: p.wt, branch: 'fix/1', base: 'origin/develop', localFiles: ['.claude', '.mcp.json', '.npmrc', 'notes.txt'] })
    const { lstatSync, readlinkSync } = require('node:fs') as typeof import('node:fs')
    expect(readlinkSync(join(p.wt, '.mcp.json'))).toBe(join(p.main, '.mcp.json'))
    expect(readlinkSync(join(p.wt, '.claude', 'skills'))).toBe(join(p.main, '.claude', 'skills'))
    expect(lstatSync(join(p.wt, '.claude', 'settings.local.json')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(p.wt, '.claude', 'commands')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(p.wt, 'notes.txt'))).toBe(false) // not ignored: it would be shipped
    expect(existsSync(join(p.wt, '.npmrc'))).toBe(false) // the main checkout has none
    expect(git(p.wt, 'status', '--porcelain')).toBe('')
    expect(r.notes.join(' ')).toContain('linked .claude/settings.local.json, .claude/skills, .mcp.json')
  })
})

describe('createWorktree: files tools write', () => {
  test("argent's .argent/ is ignored in the worktree: not a change, not shipped", async () => {
    const p = project()
    await createWorktree({ repo: p.main, worktree: p.wt, branch: 'fix/7', base: 'origin/develop', ignore: ['.argent/'] })
    mkdirSync(join(p.wt, '.argent'), { recursive: true }); writeFileSync(join(p.wt, '.argent', 'x.json'), '{}')
    expect(git(p.wt, 'status', '--porcelain')).toBe('')
  })
})

describe('createWorktree: the setup log', () => {
  test('each step with its time, and the install\'s own output as it comes', async () => {
    const p = project(), log = join(p.root, 'setup.log')
    writeFileSync(log, '')
    await createWorktree({ repo: p.main, worktree: p.wt, branch: 'fix/8', base: 'origin/develop', install: 'echo resolving packages; echo done', log })
    const text = readFileSync(log, 'utf8')
    for (const l of ['fetching origin', 'worktree', 'node_modules cloned in', '$ echo resolving packages; echo done', 'resolving packages', 'installed in', 'ready in']) expect(text).toContain(l)
    expect(text).toMatch(/^\d\d:\d\d:\d\d fetching origin/)
  })
})

describe('createWorktree: indexes the run gets its own copy of', () => {
  test("cloned from the main checkout, not linked (writes stay the run's), excluded from git; its sync runs in the background", async () => {
    const p = project()
    mkdirSync(join(p.main, '.codegraph'), { recursive: true }); writeFileSync(join(p.main, '.codegraph', 'codegraph.db'), 'index of develop')
    const log = join(p.root, 'setup.log'); writeFileSync(log, '')
    await createWorktree({ repo: p.main, worktree: p.wt, branch: 'fix/9', base: 'origin/patch/3.20.7', localFiles: ['.codegraph'], indexes: [{ dir: '.codegraph', sync: 'echo synced > .codegraph/synced' }], log })
    const { lstatSync } = require('node:fs') as typeof import('node:fs')
    expect(lstatSync(join(p.wt, '.codegraph')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(p.wt, '.codegraph', 'codegraph.db'), 'utf8')).toBe('index of develop')
    writeFileSync(join(p.wt, '.codegraph', 'codegraph.db'), 'index of the release line')
    expect(readFileSync(join(p.main, '.codegraph', 'codegraph.db'), 'utf8')).toBe('index of develop')
    for (let i = 0; i < 100 && !existsSync(join(p.wt, '.codegraph', 'synced')); i++) await Bun.sleep(20)
    expect(readFileSync(join(p.wt, '.codegraph', 'synced'), 'utf8')).toBe('synced\n')
    expect(git(p.wt, 'status', '--porcelain')).toBe('')
    expect(readFileSync(log, 'utf8')).toContain('.codegraph: copied from the main checkout; echo synced > .codegraph/synced in the background')
  })
  test('the main checkout has no index: none is made (indexing is the user\'s decision)', async () => {
    const p = project()
    await createWorktree({ repo: p.main, worktree: p.wt, branch: 'fix/10', base: 'origin/develop', indexes: [{ dir: '.codegraph', sync: 'touch made' }] })
    await Bun.sleep(100)
    expect(existsSync(join(p.wt, '.codegraph'))).toBe(false)
    expect(existsSync(join(p.wt, 'made'))).toBe(false)
  })
})
