import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verify } from '../src/verify.ts'
import type { VerifyStep } from '../src/config.ts'

// The agent never commits, so its changes are the working tree's; the base is the same tree with them stashed.
// Only findings new against the base count: the base branch may already be red.
const TOOLS = `${process.execPath} ${join(import.meta.dir, 'fake-tools.ts')}`
const steps: VerifyStep[] = [
  { name: 'tsc', kind: 'tsc', cmd: `${TOOLS} tsc`, changedOnly: false },
  { name: 'eslint', kind: 'eslint', cmd: `${TOOLS} eslint {json} {files}`, changedOnly: true, ext: ['ts'] },
  { name: 'jest', kind: 'jest', cmd: `${TOOLS} jest {json} {files}`, changedOnly: true, ext: ['ts'] },
]
const git = (cwd: string, ...a: string[]) => Bun.spawnSync(['git', ...a], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })

/** a repo whose base already has a type error in a.ts */
function repo() {
  const wt = mkdtempSync(join(tmpdir(), 'flow-verify-'))
  mkdirSync(join(wt, 'src'))
  writeFileSync(join(wt, 'src/a.ts'), 'const a = 1 // ERR old\n')
  writeFileSync(join(wt, 'src/b.ts'), 'const b = 2\n')
  git(wt, 'init', '-q'); git(wt, 'add', '.'); git(wt, 'commit', '-qm', 'base')
  return wt
}

describe('verify: findings new against the base', () => {
  test('a change that adds nothing bad: ok, though the base was already red', async () => {
    const wt = repo()
    writeFileSync(join(wt, 'src/b.ts'), 'const b = 3\n')
    const r = await verify(wt, steps)
    expect(r.ok).toBe(true)
    expect(r.steps.find(s => s.name === 'tsc')).toMatchObject({ status: 'ok', head: 1, base: 1, newFindings: [] })
  })
  test('a new type error, lint error and failing test are reported, each once; the old error is not', async () => {
    const wt = repo()
    writeFileSync(join(wt, 'src/b.ts'), 'const b = 3 // ERR new\n// LINT here\n// FAIL\n')
    const r = await verify(wt, steps)
    expect(r.ok).toBe(false)
    expect(r.steps.map(s => [s.name, s.status, s.newFindings])).toEqual([
      ['tsc', 'new', ['src/b.ts|TS2322|const b = 3 // ERR new']],
      ['eslint', 'new', ['src/b.ts|no-lint|// LINT here']],
      ['jest', 'new', ['src/b.ts|src/b.ts works']],
    ])
  })
  test('moving an old error to another line is not new (line numbers are left out of the comparison)', async () => {
    const wt = repo()
    writeFileSync(join(wt, 'src/a.ts'), '\n\nconst a = 1 // ERR old\n')
    expect((await verify(wt, steps)).ok).toBe(true)
  })
  test('a new file is checked: at the base it does not exist, so all its findings are new', async () => {
    const wt = repo()
    writeFileSync(join(wt, 'src/c.ts'), '// LINT in a new file\n')
    const r = await verify(wt, steps)
    expect(r.changed).toEqual(['src/c.ts'])
    expect(r.steps.find(s => s.name === 'eslint')!.newFindings).toEqual(['src/c.ts|no-lint|// LINT in a new file'])
  })
  test('the agent\'s changes are back exactly as they were afterwards, untracked files included', async () => {
    const wt = repo()
    writeFileSync(join(wt, 'src/b.ts'), 'changed\n')
    writeFileSync(join(wt, 'src/new.ts'), 'brand new\n')
    await verify(wt, steps)
    expect(readFileSync(join(wt, 'src/b.ts'), 'utf8')).toBe('changed\n')
    expect(readFileSync(join(wt, 'src/new.ts'), 'utf8')).toBe('brand new\n')
    expect(new TextDecoder().decode(git(wt, 'stash', 'list').stdout)).toBe('')
  })
  test('a tool that fails at the base too is "not comparable": reported, but it does not block', async () => {
    const wt = repo()
    writeFileSync(join(wt, 'src/b.ts'), 'x\n')
    const r = await verify(wt, [{ name: 'eslint', kind: 'eslint', cmd: `${TOOLS} crash`, changedOnly: true, ext: ['ts'] }])
    expect(r.ok).toBe(true)
    expect(r.steps[0]).toMatchObject({ status: 'error', note: expect.stringMatching(/did not run at the base either/) })
  })
  test('nothing changed: nothing to verify', async () => {
    const r = await verify(repo(), steps)
    expect(r).toMatchObject({ ok: true, changed: [], note: 'no changes' })
  })
  test('only files with the step\'s extensions are passed to it', async () => {
    const wt = repo()
    writeFileSync(join(wt, 'README.md'), 'LINT in docs\n')
    const r = await verify(wt, steps)
    expect(r.steps.find(s => s.name === 'eslint')).toMatchObject({ status: 'ok', note: 'no matching files' })
  })
})

describe('verify per package (a monorepo whose tools run inside each package)', () => {
  function mono() {
    const wt = mkdtempSync(join(tmpdir(), 'flow-mono-'))
    for (const p of ['a', 'b']) { mkdirSync(join(wt, 'packages', p, 'src'), { recursive: true }); writeFileSync(join(wt, 'packages', p, 'src/x.ts'), 'export const x = 1\n') }
    git(wt, 'init', '-q'); git(wt, 'add', '.'); git(wt, 'commit', '-qm', 'base')
    return wt
  }
  const lint: VerifyStep = { name: 'eslint', kind: 'eslint', cmd: `${TOOLS} eslint {json} {files}`, changedOnly: true, ext: ['ts'], perPackage: 'packages/*' }
  const tsc: VerifyStep = { name: 'tsc', kind: 'tsc', cmd: `${TOOLS} tsc`, changedOnly: false, perPackage: 'packages/*' }
  test('a changed-files step runs only in the packages with changes, files relative to it; findings name the full path', async () => {
    const wt = mono()
    writeFileSync(join(wt, 'packages/b/src/x.ts'), '// LINT in b\n')
    const r = await verify(wt, [lint])
    expect(r.steps[0]).toMatchObject({ status: 'new', newFindings: ['packages/b/src/x.ts|no-lint|// LINT in b'] })
  })
  test('a whole-project step runs in every package, judged against the base per package', async () => {
    const wt = mono()
    writeFileSync(join(wt, 'packages/a/src/x.ts'), 'export const x = 2 // ERR in a\n')
    const r = await verify(wt, [tsc])
    expect(r.steps[0]).toMatchObject({ status: 'new', newFindings: ['packages/a/src/x.ts|TS2322|export const x = 2 // ERR in a'] })
  })
  test('vitest reports read like jest\'s', async () => {
    const wt = mono()
    writeFileSync(join(wt, 'packages/a/src/x.ts'), '// FAIL\n')
    const r = await verify(wt, [{ name: 'vitest', kind: 'vitest', cmd: `${TOOLS} jest {json} {files}`, changedOnly: true, ext: ['ts'], perPackage: 'packages/*' }])
    expect(r.steps[0]!.newFindings).toEqual(['packages/a/src/x.ts|src/x.ts works'])
  })
})
