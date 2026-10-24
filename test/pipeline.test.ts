import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAgent, type FakeTurn } from '../src/agent/fake.ts'
import type { Az } from '../src/azure.ts'
import { parseProject } from '../src/config.ts'
import { Pipeline } from '../src/pipeline.ts'
import { EventStore } from '../src/store.ts'

// Whole runs: a real git project (origin + main checkout), a stand-in az, stand-in tools for verify, and a fake
// agent whose turns change files the way a real agent would.
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...a: string[]) => new TextDecoder().decode(Bun.spawnSync(['git', ...a], { cwd, env }).stdout).trim()
const TOOLS = `${process.execPath} ${join(import.meta.dir, 'fake-tools.ts')}`
const result = (text = 'done') => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, session_id: 's-1', usage: { input_tokens: 1000, output_tokens: 100 } })
const turn = (effect?: (prompt: string) => void, text?: string): FakeTurn => ({ stream: [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1', model: 'm', apiKeySource: 'none' }), result(text)].join('\n'), effect })

function setup(turns: (dirs: { wt: string; run: string }) => FakeTurn[], o: { review?: FakeTurn[]; reviewOff?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flow-pipe-'))
  const origin = join(root, 'origin.git'), main = join(root, 'main')
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'develop', origin])
  Bun.spawnSync(['git', 'clone', '-q', origin, main], { env })
  mkdirSync(join(main, 'src'))
  writeFileSync(join(main, 'src/a.ts'), 'const a = 1 // ERR already on develop\n')
  writeFileSync(join(main, '.gitignore'), 'node_modules/\n')
  git(main, 'add', '.'); git(main, 'commit', '-qm', 'base'); git(main, 'push', '-q', 'origin', 'HEAD:develop')
  const project = parseProject({
    key: 'example', name: 'Example', worktrees: join(root, 'worktrees'),
    tracker: { kind: 'azure', org: 'https://dev.azure.com/example', project: 'example' }, forge: { kind: 'azure', org: 'https://dev.azure.com/example', project: 'example' },
    ...(o.reviewOff ? { review: { enabled: false } } : {}),
    repos: [{ key: 'mobile', path: main, defaultBase: 'origin/develop', verify: [
      { name: 'tsc', kind: 'tsc', cmd: `${TOOLS} tsc` },
      { name: 'eslint', kind: 'eslint', cmd: `${TOOLS} eslint {json} {files}`, changedOnly: true, ext: ['ts'] },
    ] }],
  }, 'test')
  const azCalls: string[][] = []
  const az: Az = args => {
    azCalls.push(args)
    if (args.includes('work-item')) return { code: 0, out: JSON.stringify({ fields: { 'System.Title': 'Asset list crashes', 'System.WorkItemType': 'Bug', 'System.Description': '<p>It crashes.</p>' } }), err: '' }
    if (args.includes('pr')) return { code: 0, out: JSON.stringify({ pullRequestId: 4711 }), err: '' }
    return { code: 0, out: '{"comments":[]}', err: '' }
  }
  const dataDir = join(root, 'data')
  const wt = join(root, 'worktrees', '186278', 'mobile'), runDir = join(dataDir, 'runs', 'example-186278')
  const agent = new FakeAgent(turns({ wt, run: runDir }))
  const agents: { cwd: string; settings: string; resume?: string }[] = []
  const store = new EventStore(':memory:')
  const reviewer = new FakeAgent(o.review ?? [])
  const reviewers: { cwd: string; settings: string }[] = []
  const pipe = new Pipeline({ store, project, az, dataDir, gitEnv: env, makeAgent: o => { agents.push(o); return agent },
    ...(o.review ? { makeReviewer: (x: { cwd: string; settings: string }) => { reviewers.push(x); return reviewer } } : {}) })
  return { pipe, store, agent, reviewer, reviewers, azCalls, origin, wt, runDir, agents }
}
const review = (findings: object[]): FakeTurn => ({ stream: [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'rev-1', model: 'm', apiKeySource: 'none' }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: `Checked.\n\n\`\`\`json\n${JSON.stringify(findings)}\n\`\`\``, num_turns: 1, session_id: 'rev-1', usage: { input_tokens: 500, output_tokens: 50 } })].join('\n') })
const reviewText = (text: string): FakeTurn => ({ stream: [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'rev-1', model: 'm', apiKeySource: 'none' }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, session_id: 'rev-1', usage: { input_tokens: 500, output_tokens: 50 } })].join('\n') })
const finding = { severity: 'P1', file: 'src/b.ts', line: 1, problem: 'b is exported but never used', evidence: 'no import of b anywhere', confidence: 90 }
const plan = (questions = 'none') => `# Plan\n\nGuard the walk against missing assets.\n\n## Open questions\n${questions}\n`
const prMd = '# Guard the asset walk against missing assets\n\n## Summary\nFixes the crash.\n\nVerified: flow verify → no new findings\n'

describe('a ticket to a draft PR', () => {
  test('no open questions: plan → build → verify → waits for ship; ship commits, pushes and opens the draft PR', async () => {
    const t = setup(d => [
      turn(() => writeFileSync(join(d.run, 'plan.md'), plan())),
      turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) }),
    ])
    const run = await t.pipe.start(186278)
    expect(run).toBe('example-186278')
    expect(t.store.state(run)).toMatchObject({ ticket: '#186278', title: 'Asset list crashes', stage: 'ship', status: 'needs-you', needs: { kind: 'ship' } })
    expect(t.agent.prompts[0]).toContain('It crashes.')
    expect(t.agent.prompts[0]).toContain(join(t.runDir, 'plan.md'))
    expect(t.agents[0]).toMatchObject({ cwd: t.wt })
    // the agent's settings: flow's guard on this worktree, the run folder allowed
    expect(readFileSync(t.agents[0]!.settings, 'utf8')).toContain(t.runDir)

    await t.pipe.ship(run)
    expect(git(t.origin, 'log', '-1', '--format=%s', 'fix/186278')).toBe('fix(mobile): #186278 Asset list crashes')
    const create = t.azCalls.find(a => a.includes('create'))!
    expect(create).toEqual(expect.arrayContaining(['--draft', 'true', '--target-branch', 'develop', '--source-branch', 'fix/186278', '--work-items', '186278', '--title', '#186278 Guard the asset walk against missing assets']))
    expect(create[create.indexOf('--description') + 1]).toBe('## Summary\nFixes the crash.\n\nVerified: flow verify → no new findings')
    expect(t.store.state(run)).toMatchObject({ status: 'needs-you', needs: { kind: 'pr' }, pr: { number: 4711 } })
  })
  test('open questions: the run waits; approve with an answer, and the build turn is told it', async () => {
    const t = setup(d => [
      turn(() => writeFileSync(join(d.run, 'plan.md'), plan('- Q1: Also guard the order list? — default: no'))),
      turn(() => writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n')),
    ])
    const run = await t.pipe.start(186278)
    expect(t.store.state(run)).toMatchObject({ stage: 'plan', status: 'needs-you', needs: { kind: 'plan', deadline: expect.any(Number) } })
    await t.pipe.approve(run, { Q1: 'yes' })
    expect(t.agent.prompts[1]).toContain('Q1 Also guard the order list? → yes')
    expect(t.store.state(run)).toMatchObject({ stage: 'ship', plan: { decidedBy: 'human', answers: { Q1: 'yes' } } })
  })
  test('questions left unanswered at approve take the plan\'s defaults, and the agent is told them', async () => {
    const t = setup(d => [
      turn(() => writeFileSync(join(d.run, 'plan.md'), plan('- Q1: Guard the order list? — default: no\n- Q2: Log the skipped asset? — default: yes'))),
      turn(() => writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n')),
    ])
    const run = await t.pipe.start(186278)
    await t.pipe.approve(run, { Q1: 'yes' })
    expect(t.store.state(run)!.plan!.answers).toEqual({ Q1: 'yes', Q2: 'yes' })
    expect(t.agent.prompts[1]).toContain('Q2 Log the skipped asset? → yes')
  })
  test('at the deadline: the defaults are taken by the engine (recorded as such) and the build goes on', async () => {
    const t = setup(d => [
      turn(() => writeFileSync(join(d.run, 'plan.md'), plan('- Q1: Guard the order list? — default: no'))),
      turn(() => writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n')),
    ])
    const run = await t.pipe.start(186278)
    await t.pipe.decideByDeadline(run)
    expect(t.store.state(run)).toMatchObject({ stage: 'ship', plan: { decidedBy: 'deadline', answers: { Q1: 'no' } } })
    expect(t.store.events(run).find(e => e.type === 'plan.decided')).toMatchObject({ actor: 'engine', by: 'deadline' })
  })
  test('a held plan is never decided by the deadline', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan('- Q1 (held): Change the behaviour? — default: no')))])
    const run = await t.pipe.start(186278)
    await expect(t.pipe.decideByDeadline(run)).rejects.toThrow(/held/)
    expect(t.store.state(run)).toMatchObject({ stage: 'plan', status: 'needs-you' })
  })
  test('an answer to a question the plan does not have is refused', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan('- Q1: x? — default: y')))])
    const run = await t.pipe.start(186278)
    await expect(t.pipe.approve(run, { Q7: 'no' })).rejects.toThrow(/no question Q7/)
  })
  test('verify finds something new: the agent is told exactly what, fixes it, and verify passes', async () => {
    const t = setup(d => [
      turn(() => writeFileSync(join(d.run, 'plan.md'), plan())),
      turn(() => writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2 // ERR mine\n')),
      turn(() => writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n')),
    ])
    const run = await t.pipe.start(186278)
    expect(t.agent.prompts[2]).toContain('src/b.ts|TS2322|export const b = 2 // ERR mine')
    expect(t.agent.prompts[2]).not.toContain('ERR already on develop')
    expect(t.store.state(run)).toMatchObject({ stage: 'ship', loops: { verifyRuns: 2, verify: 0 } })
  })
  test('the agent writes no plan: asked once more, then the run is blocked saying so', async () => {
    const t = setup(() => [turn(), turn()])
    const run = await t.pipe.start(186278)
    expect(t.agent.prompts[1]).toMatch(/plan\.md is missing/)
    expect(t.store.state(run)).toMatchObject({ status: 'blocked', needs: { ask: expect.stringMatching(/no plan/) } })
  })
  test('a message to a blocked run goes to the same session and the run carries on', async () => {
    const t = setup(d => [
      turn(),
      turn(),
      turn(() => writeFileSync(join(d.run, 'plan.md'), plan())),
      turn(() => writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n')),
    ])
    const run = await t.pipe.start(186278)
    await t.pipe.message(run, 'Write the plan to plan.md now, please.')
    expect(t.agent.prompts[2]).toBe('Write the plan to plan.md now, please.')
    expect(t.store.state(run)).toMatchObject({ stage: 'ship', status: 'needs-you' })
  })
  test('ship refuses while the run is not verified', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan('- Q1: x? — default: y')))])
    const run = await t.pipe.start(186278)
    await expect(t.pipe.ship(run)).rejects.toThrow(/not ready to ship/)
  })
  test('--kind overrides the work item type (a Task that is a fix): branch and commit type follow it', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan('- Q1: x? — default: y')))])
    const run = await t.pipe.start(186278, { kind: 'feature' })
    expect(JSON.parse(readFileSync(join(t.runDir, 'run.json'), 'utf8'))).toMatchObject({ kind: 'feature', branch: 'feat/186278' })
    void run
  })
  test('the ticket and the plan are kept in the run folder', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan('- Q1: x? — default: y')))])
    await t.pipe.start(186278)
    expect(readFileSync(join(t.runDir, 'ticket.md'), 'utf8')).toContain('It crashes.')
    expect(existsSync(join(t.runDir, 'run.json'))).toBe(true)
  })
})

describe('the independent review before ship', () => {
  test('nothing found: ready to ship; the reviewer saw the new file in full; its session did not replace the run\'s', async () => {
    const t = setup(d => [
      turn(() => writeFileSync(join(d.run, 'plan.md'), plan())),
      turn(() => writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n')),
    ], { review: [review([])] })
    const run = await t.pipe.start(186278)
    expect(t.store.state(run)).toMatchObject({ stage: 'ship', needs: { kind: 'ship' }, session: 's-1' })
    expect(t.reviewer.prompts[0]).toContain('+export const b = 2')
    expect(t.reviewer.prompts[0]).toContain('Guard the walk against missing assets.')
    expect(t.reviewers[0]).toMatchObject({ cwd: t.wt })
    expect(JSON.parse(readFileSync(join(t.runDir, 'review.json'), 'utf8'))).toMatchObject({ review: 1, findings: [] })
  })
  test('a finding goes to the agent; after its fix, verify and review run again, then ready to ship', async () => {
    const t = setup(d => [
      turn(() => writeFileSync(join(d.run, 'plan.md'), plan())),
      turn(() => writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n')),
      turn(() => writeFileSync(join(d.wt, 'src/b.ts'), 'const b = 2\nconsole.log(b)\n')),
    ], { review: [review([finding]), review([])] })
    const run = await t.pipe.start(186278)
    expect(t.agent.prompts[2]).toContain('R1 [P1] src/b.ts:1: b is exported but never used')
    expect(t.store.events(run).map(e => e.type).filter(x => /review|verify|build/.test(x))).toEqual(['build.done', 'verify.result', 'review.result', 'build.done', 'verify.result', 'review.result'])
    expect(t.store.state(run)).toMatchObject({ stage: 'ship', loops: { review: 1 } })
  })
  test('an unreadable review is asked for once more, then recorded as skipped with the reason; it never counts as clean', async () => {
    const t = setup(d => [
      turn(() => writeFileSync(join(d.run, 'plan.md'), plan())),
      turn(() => writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n')),
    ], { review: [reviewText('LGTM'), reviewText('still no json')] })
    const run = await t.pipe.start(186278)
    expect(t.reviewer.prompts[1]).toMatch(/one .*json/i)
    expect(t.store.events(run).find(e => e.type === 'review.skipped')).toMatchObject({ reason: expect.stringMatching(/review unreadable.*no JSON array/) })
    expect(t.store.state(run)).toMatchObject({ needs: { kind: 'ship' } })
  })
  test('review turned off for the project: skipped, saying so', async () => {
    const t = setup(d => [
      turn(() => writeFileSync(join(d.run, 'plan.md'), plan())),
      turn(() => writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n')),
    ], { review: [], reviewOff: true })
    const run = await t.pipe.start(186278)
    expect(t.store.events(run).find(e => e.type === 'review.skipped')).toMatchObject({ reason: 'review is off for this project' })
    expect(t.reviewer.prompts).toEqual([])
  })
})
