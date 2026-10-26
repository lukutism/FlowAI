import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { drift, prProblems } from '../src/drift.ts'

// Only the fix, and nothing that shouldn't be published: what the change adds beyond what the plan's PR extras allow,
// and what the PR description says. Each finding is file|rule|message, the format verify findings have.
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
function repo() {
  const wt = mkdtempSync(join(tmpdir(), 'flow-drift-'))
  const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: wt, env })
  git('init', '-q')
  mkdirSync(join(wt, 'src'))
  writeFileSync(join(wt, 'src/a.ts'), 'export const a = 1\n// an old comment\n')
  writeFileSync(join(wt, 'src/a.test.ts'), 'test("a", () => {})\n')
  writeFileSync(join(wt, '.env'), 'A=1\n')
  git('add', '.'); git('commit', '-qm', 'base')
  return wt
}
const none = { tests: false, comments: false }

describe('drift: what the change adds', () => {
  test('just the fix: nothing found; an existing comment or suppression does not count', async () => {
    const wt = repo()
    writeFileSync(join(wt, 'src/a.ts'), 'export const a = 2\n// an old comment\n')
    expect(await drift(wt, none)).toEqual([])
  })
  test('new suppressions, comment lines, test files and edited tests are named, with where', async () => {
    const wt = repo()
    writeFileSync(join(wt, 'src/a.ts'), 'export const a = 2 // ts-ignore? no\n// an old comment\n// why this works\n// @ts-ignore\nconst b: number = "x"\n')
    writeFileSync(join(wt, 'src/b.test.ts'), 'test.only("b", () => {})\n')
    writeFileSync(join(wt, 'src/a.test.ts'), 'test("a changed", () => {})\n')
    const f = await drift(wt, none)
    expect(f).toContainEqual(expect.stringMatching(/^src\/a\.ts:4\|suppression\|/))
    expect(f).toContainEqual(expect.stringMatching(/^src\/b\.test\.ts:1\|suppression\|/))
    expect(f).toContainEqual(expect.stringMatching(/^src\/a\.ts\|comments\|3 new comment lines \(1, 3, 4\)/))
    expect(f).toContainEqual(expect.stringMatching(/^src\/b\.test\.ts\|tests\|a new test file.*PR extras/))
    expect(f).toContainEqual(expect.stringMatching(/^src\/a\.test\.ts\|tests\|an edited test file/))
  })
  test('PR extras that name tests and comments allow them; suppressions never', async () => {
    const wt = repo()
    writeFileSync(join(wt, 'src/a.ts'), 'export const a = 2\n// an old comment\n// asked for\n')
    writeFileSync(join(wt, 'src/b.test.ts'), 'test("b", () => {})\n')
    expect(await drift(wt, { tests: true, comments: true })).toEqual([])
  })
  test('a local path in the change, and an edited env file, would be published', async () => {
    const wt = repo()
    writeFileSync(join(wt, 'src/a.ts'), `export const a = '${homedir()}/x'\n// an old comment\n`)
    writeFileSync(join(wt, '.env'), 'A=2\n')
    const f = await drift(wt, none)
    expect(f).toContainEqual(expect.stringMatching(/^src\/a\.ts:1\|leak\|a local path/))
    expect(f).toContainEqual(expect.stringMatching(/^\.env\|leak\|an env file/))
  })
})

describe('prProblems: what the PR description says', () => {
  const good = '# Fix it\n\nWhat changed.\n\nVerified: yarn jest src/a.test.ts → 3 passed\nNot verified: the device — no access\n'
  test('a description with its proof lines is fine', () => {
    expect(prProblems(good, { repro: 'test', evidence: [] })).toEqual([])
  })
  test('missing proof lines, a local path, the agent named: each a finding on pr.md', () => {
    const f = prProblems(`# Fix\n\nClaude found it in ${homedir()}/fso.\n`, { repro: 'test', evidence: [] })
    expect(f).toContainEqual(expect.stringMatching(/^pr\.md\|proof\|.*Verified:/))
    expect(f).toContainEqual(expect.stringMatching(/^pr\.md\|proof\|.*Not verified:/))
    expect(f).toContainEqual(expect.stringMatching(/^pr\.md\|leak\|a local path/))
    expect(f).toContainEqual(expect.stringMatching(/^pr\.md\|leak\|the agent/))
  })
  test('Repro: live needs its before-screenshot', () => {
    expect(prProblems(good, { repro: 'live', evidence: [] })).toEqual([expect.stringMatching(/^evidence\|repro\|Repro: live needs .*before-\*\.png/)])
    expect(prProblems(good, { repro: 'live', evidence: ['before-list.png'] })).toEqual([])
  })
})
