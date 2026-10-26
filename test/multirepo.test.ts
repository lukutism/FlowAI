import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAgent, type FakeTurn } from '../src/agent/fake.ts'
import type { Az } from '../src/azure.ts'
import { parseProject } from '../src/config.ts'
import { Pipeline } from '../src/pipeline.ts'
import { EventStore } from '../src/store.ts'
import { fullPlan } from './plans.ts'

// A run across several repos: one branch name, a worktree per repo under the run's root, verify and review per
// repo, and one draft PR per repo that changed.
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...a: string[]) => new TextDecoder().decode(Bun.spawnSync(['git', ...a], { cwd, env }).stdout).trim()
const TOOLS = `${process.execPath} ${join(import.meta.dir, 'fake-tools.ts')}`
const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1', model: 'm', apiKeySource: 'none' })
const turn = (effect?: () => void): FakeTurn => ({ stream: `${init}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, session_id: 's-1', usage: { input_tokens: 10, output_tokens: 10 } })}`, effect })

function repo(root: string, name: string, branches: string[] = []) {
  const origin = join(root, `${name}.git`), main = join(root, name)
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'develop', origin])
  Bun.spawnSync(['git', 'clone', '-q', origin, main], { env })
  mkdirSync(join(main, 'src'))
  writeFileSync(join(main, 'src/a.ts'), `export const ${name} = 1\n`); writeFileSync(join(main, '.gitignore'), 'node_modules/\n')
  git(main, 'add', '.'); git(main, 'commit', '-qm', 'base'); git(main, 'push', '-q', 'origin', 'HEAD:develop')
  for (const b of branches) git(main, 'push', '-q', 'origin', `HEAD:refs/heads/${b}`)
  return { origin, main }
}

function setup(turns: (d: { root: string; run: string }) => FakeTurn[], o: { defaults?: string[] } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'flow-multi-'))
  const mobile = repo(base, 'mobile'), portal = repo(base, 'portal', ['release/1'])
  const steps = [{ name: 'eslint', kind: 'eslint', cmd: `${TOOLS} eslint {json} {files}`, changedOnly: true, ext: ['ts'] }]
  const project = parseProject({
    key: 'ex', name: 'Ex', worktrees: join(base, 'wt'), tracker: { kind: 'azure', org: 'https://dev.azure.com/x', project: 'x' }, forge: { kind: 'azure', org: 'https://dev.azure.com/x', project: 'x' },
    repos: [
      { key: 'mobile', path: mobile.main, defaultBase: 'origin/develop', verify: steps, default: (o.defaults ?? ['mobile']).includes('mobile') },
      { key: 'portal', path: portal.main, defaultBase: 'origin/develop', verify: steps, default: (o.defaults ?? ['mobile']).includes('portal') },
    ],
  }, 't')
  const azCalls: string[][] = []
  let pr = 100
  const az: Az = args => {
    azCalls.push(args)
    if (args.includes('work-item')) return { code: 0, out: JSON.stringify({ fields: { 'System.Title': 'Show the quantity', 'System.WorkItemType': 'Bug' } }), err: '' }
    if (args.includes('create')) return { code: 0, out: JSON.stringify({ pullRequestId: ++pr }), err: '' }
    return { code: 0, out: '{"comments":[]}', err: '' }
  }
  const data = join(base, 'data'), root = join(base, 'wt', '7'), runDir = join(data, 'runs', 'ex-7')
  const agent = new FakeAgent(turns({ root, run: runDir }))
  const reviewer = new FakeAgent([turn(), turn(), turn()].map(() => ({ stream: `${init}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '```json\n[]\n```', num_turns: 1, session_id: 'r', usage: {} })}` })))
  const made: { cwd: string; settings: string }[] = []
  const store = new EventStore(':memory:')
  const pipe = new Pipeline({ store, project, az, dataDir: data, gitEnv: env, makeAgent: x => { made.push(x); return agent }, makeReviewer: () => reviewer })
  return { pipe, store, agent, reviewer, azCalls, made, root, runDir, mobile, portal }
}
const plan = fullPlan('none', 'Show the remaining quantity in both apps.')

describe('a run across two repos', () => {
  const both = (d: { root: string; run: string }) => [
    turn(() => writeFileSync(join(d.run, 'plan.md'), plan)),
    turn(() => { writeFileSync(join(d.root, 'mobile', 'src/a.ts'), 'export const mobile = 2\n'); writeFileSync(join(d.root, 'portal', 'src/a.ts'), 'export const portal = 2\n'); writeFileSync(join(d.run, 'pr.md'), '# Both repos\n\nVerified: tsc → clean\nNot verified: nothing\n') }),
  ]
  test('the agent works in the run\'s root, told where each repo is; the guard allows every worktree', async () => {
    const t = setup(both)
    await t.pipe.start(7, { repos: ['mobile', 'portal'] })
    expect(t.made[0]!.cwd).toBe(t.root)
    expect((t.made[0] as { appendSystemPrompt?: string }).appendSystemPrompt).toContain(`mobile: ${join(t.root, 'mobile')} (from origin/develop)`)
    expect((t.made[0] as { appendSystemPrompt?: string }).appendSystemPrompt).toContain(`portal: ${join(t.root, 'portal')} (from origin/develop)`)
    const settings = readFileSync(t.made[0]!.settings, 'utf8')
    expect(settings).toContain(join(t.root, 'mobile')); expect(settings).toContain(join(t.root, 'portal'))
    expect(git(join(t.root, 'portal'), 'branch', '--show-current')).toBe('fix/7')
  })
  test('the reviewer sees the change in every repo', async () => {
    const t = setup(both)
    await t.pipe.start(7, { repos: ['mobile', 'portal'] })
    expect(t.reviewer.prompts[0]).toContain('+export const mobile = 2')
    expect(t.reviewer.prompts[0]).toContain('+export const portal = 2')
  })
  test('ship: a commit, a push and a draft PR per repo; the run lists both PRs', async () => {
    const t = setup(both)
    const run = await t.pipe.start(7, { repos: ['mobile', 'portal'] })
    await t.pipe.ship(run)
    expect(git(t.mobile.origin, 'show', 'fix/7:src/a.ts')).toBe('export const mobile = 2')
    expect(git(t.portal.origin, 'show', 'fix/7:src/a.ts')).toBe('export const portal = 2')
    const creates = t.azCalls.filter(a => a.includes('create'))
    expect(creates.map(c => c[c.indexOf('--repository') + 1])).toEqual(['mobile', 'portal'])
    expect(t.pipe.state(run)).toMatchObject({ prs: [{ repo: 'mobile', number: 101 }, { repo: 'portal', number: 102 }], needs: { ask: 'review draft PRs #101, #102' } })
  })
  test('a repo the agent left unchanged gets no PR', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan)), turn(() => { writeFileSync(join(d.root, 'portal', 'src/a.ts'), 'export const portal = 3\n'); writeFileSync(join(d.run, 'pr.md'), '# Portal only\n\nVerified: tsc → clean\nNot verified: nothing\n') })])
    const run = await t.pipe.start(7, { repos: ['mobile', 'portal'] })
    await t.pipe.ship(run)
    expect(t.azCalls.filter(a => a.includes('create')).map(c => c[c.indexOf('--repository') + 1])).toEqual(['portal'])
  })
  test('verify findings name their repo', async () => {
    const t = setup(d => [
      turn(() => writeFileSync(join(d.run, 'plan.md'), plan)),
      turn(() => writeFileSync(join(d.root, 'portal', 'src/a.ts'), '// LINT in portal\n')),
      turn(() => writeFileSync(join(d.root, 'portal', 'src/a.ts'), 'export const portal = 2\n')),
    ])
    await t.pipe.start(7, { repos: ['mobile', 'portal'] })
    expect(t.agent.prompts[2]).toContain('portal: src/a.ts|no-lint|// LINT in portal')
  })
  test('without --repos: the project\'s default repos; a base per repo', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan.replace('none', '- Q1: x? — default: y')))], { defaults: ['portal'] })
    const run = await t.pipe.start(7, { bases: { portal: 'origin/release/1' } })
    expect(JSON.parse(readFileSync(join(t.runDir, 'run.json'), 'utf8')).repos).toEqual([{ key: 'portal', worktree: join(t.root, 'portal'), base: 'origin/release/1' }])
    expect(t.pipe.state(run)!.base).toBe('origin/release/1')
  })
  test('an unknown repo is refused before anything is created', async () => {
    const t = setup(() => [])
    await expect(t.pipe.start(7, { repos: ['mobile', 'nope'] })).rejects.toThrow(/no repo nope in project ex/)
  })
})
