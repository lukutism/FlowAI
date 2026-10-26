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
const turn = (effect?: () => void | Promise<void>): FakeTurn => ({ stream: `${init}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, session_id: 's-1', usage: { input_tokens: 10, output_tokens: 10 } })}`, effect })

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
      turn(() => { writeFileSync(join(d.root, 'portal', 'src/a.ts'), '// LINT in portal\n'); writeFileSync(join(d.run, 'pr.md'), '# Portal\n\nVerified: tsc → clean\nNot verified: nothing\n') }),
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

describe('a repo added to a running run', () => {
  test('its own worktree on the run\'s branch beside the others; the agent\'s next turn is told it and may write there', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), fullPlan('- Q1: Also the portal? — default: no'))), turn()])
    const run = await t.pipe.start(7)
    expect(t.store.state(run)).toMatchObject({ status: 'needs-you', needs: { kind: 'plan' }, repos: ['mobile'] })
    expect((t.made[0] as { appendSystemPrompt?: string }).appendSystemPrompt).toContain("The project's other repos (portal) can be added")
    const note = await t.pipe.addRepo(run, 'portal')
    expect(t.store.state(run)!.repos).toEqual(['mobile', 'portal'])
    expect(note).toContain(join(t.root, 'portal'))
    expect(git(join(t.root, 'portal'), 'branch', '--show-current')).toBe('fix/7')
    expect(JSON.parse(readFileSync(join(t.runDir, 'run.json'), 'utf8')).repos.map((r: { key: string }) => r.key)).toEqual(['mobile', 'portal'])
    expect(t.store.events(run).map(e => e.type)).toContain('repo.added')
    await t.pipe.message(run, 'carry on')
    const last = t.made.at(-1) as { cwd: string; settings: string; appendSystemPrompt?: string }
    expect(last.cwd).toBe(join(t.root, 'mobile')) // the session's folder stays (it resumes there)
    expect(last.appendSystemPrompt).toContain(`portal: ${join(t.root, 'portal')}`)
    expect(readFileSync(last.settings, 'utf8')).toContain(join(t.root, 'portal'))
  })
  test('a repo the run has, or the project lacks, is refused', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), fullPlan('- Q1: x? — default: y')))])
    const run = await t.pipe.start(7)
    await expect(t.pipe.addRepo(run, 'mobile')).rejects.toThrow(/has mobile already/)
    await expect(t.pipe.addRepo(run, 'cloud')).rejects.toThrow(/no repo cloud/)
  })
})

describe('sync: the run brought up to its base', () => {
  test('the base moved on: merged under the agent\'s uncommitted change, which stays uncommitted', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), fullPlan('- Q1: x? — default: y')))])
    const run = await t.pipe.start(7)
    const wt = join(t.root, 'mobile')
    writeFileSync(join(wt, 'src/a.ts'), 'export const mobile = 5\n')
    writeFileSync(join(t.mobile.main, 'src/new.ts'), 'export const n = 1\n'); git(t.mobile.main, 'add', '.'); git(t.mobile.main, 'commit', '-qm', 'moved on'); git(t.mobile.main, 'push', '-q', 'origin', 'HEAD:develop')
    expect(await t.pipe.sync(run)).toEqual(['mobile: brought up to origin/develop'])
    expect(readFileSync(join(wt, 'src/new.ts'), 'utf8')).toBe('export const n = 1\n')
    expect(readFileSync(join(wt, 'src/a.ts'), 'utf8')).toBe('export const mobile = 5\n')
    expect(git(wt, 'status', '--porcelain')).toBe('M src/a.ts')
  })
  test('the base changed the same lines: the change is left as it was, the files named', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), fullPlan('- Q1: x? — default: y')))])
    const run = await t.pipe.start(7)
    const wt = join(t.root, 'mobile')
    writeFileSync(join(wt, 'src/a.ts'), 'export const mobile = 5\n')
    writeFileSync(join(t.mobile.main, 'src/a.ts'), 'export const mobile = 9\n'); git(t.mobile.main, 'commit', '-qam', 'same line'); git(t.mobile.main, 'push', '-q', 'origin', 'HEAD:develop')
    await expect(t.pipe.sync(run)).rejects.toThrow(/mobile: the change conflicts with origin\/develop in src\/a\.ts/)
    expect(readFileSync(join(wt, 'src/a.ts'), 'utf8')).toBe('export const mobile = 5\n')
    expect(git(wt, 'stash', 'list')).toBe('')
  })
})

describe('a repo the agent adds itself', () => {
  test('add_repo makes its worktree; when the turn ends, the session restarts with it and carries on, nobody in between', async () => {
    let pipe: Pipeline | undefined
    const t = setup(d => [
      turn(async () => { const r = await pipe!.callTool('ex-7', 'add_repo', { repo: 'portal' }); expect(r.text).toMatch(/portal is at .*End your turn now/) }),
      turn(() => writeFileSync(join(d.run, 'plan.md'), fullPlan('- Q1: x? — default: y'))),
    ])
    pipe = t.pipe
    const run = await t.pipe.start(7)
    expect(git(join(t.root, 'portal'), 'branch', '--show-current')).toBe('fix/7')
    expect(t.agent.prompts[1]).toMatch(/^portal is added to this run and writable now/)
    expect((t.made.at(-1) as { appendSystemPrompt?: string }).appendSystemPrompt).toContain(`portal: ${join(t.root, 'portal')}`)
    expect(t.made).toHaveLength(2) // a new session process, resuming the same session
    expect(t.store.events(run).find(e => e.type === 'repo.added')).toMatchObject({ actor: 'agent', repo: 'portal' })
    expect(t.store.state(run)).toMatchObject({ stage: 'plan', needs: { kind: 'plan' } })
  })
})
