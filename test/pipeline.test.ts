import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAgent, type FakeTurn } from '../src/agent/fake.ts'
import type { Az } from '../src/azure.ts'
import { parseProject } from '../src/config.ts'
import { Pipeline } from '../src/pipeline.ts'
import { EventStore } from '../src/store.ts'
import { Resources } from '../src/resources.ts'

// Whole runs: a real git project (origin + main checkout), a stand-in az, stand-in tools for verify, and a fake
// agent whose turns change files the way a real agent would.
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...a: string[]) => new TextDecoder().decode(Bun.spawnSync(['git', ...a], { cwd, env }).stdout).trim()
const TOOLS = `${process.execPath} ${join(import.meta.dir, 'fake-tools.ts')}`
const result = (text = 'done') => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, session_id: 's-1', usage: { input_tokens: 1000, output_tokens: 100 } })
const turn = (effect?: (prompt: string) => void, text?: string): FakeTurn => ({ stream: [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1', model: 'm', apiKeySource: 'none' }), result(text)].join('\n'), effect })

function setup(turns: (dirs: { wt: string; run: string }) => FakeTurn[], o: { review?: FakeTurn[]; reviewOff?: boolean; release?: boolean; resources?: (store: EventStore) => Resources } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flow-pipe-'))
  const origin = join(root, 'origin.git'), main = join(root, 'main')
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'develop', origin])
  Bun.spawnSync(['git', 'clone', '-q', origin, main], { env })
  mkdirSync(join(main, 'src'))
  writeFileSync(join(main, 'src/a.ts'), 'const a = 1 // ERR already on develop\n')
  writeFileSync(join(main, '.gitignore'), 'node_modules/\n')
  git(main, 'add', '.'); git(main, 'commit', '-qm', 'base'); git(main, 'push', '-q', 'origin', 'HEAD:develop')
  // a release line cut from develop (the base for release fixes that are later ported)
  if (o.release) git(main, 'push', '-q', 'origin', 'HEAD:refs/heads/patch/1.0')
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
  const resources = o.resources?.(store)
  const pipe = new Pipeline({ store, project, az, dataDir, gitEnv: env, makeAgent: o => { agents.push(o); return agent }, ...(resources ? { resources } : {}),
    ...(o.review ? { makeReviewer: (x: { cwd: string; settings: string }) => { reviewers.push(x); return reviewer } } : {}) })
  return { pipe, store, agent, reviewer, reviewers, azCalls, origin, main, wt, runDir, agents, root, resources }
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
    // the agent's settings: flow's guard on this worktree; of the run folder only plan.md and pr.md (run.json,
    // device.json and the settings themselves are flow's), and flow's token is not to be read
    const settings = readFileSync(t.agents[0]!.settings, 'utf8')
    const allow = /FLOW_ALLOW='([^']*)'/.exec(settings)![1]!.split(':')
    expect(allow).toEqual(expect.arrayContaining([join(t.runDir, 'plan.md'), join(t.runDir, 'pr.md')]))
    expect(allow).not.toContain(t.runDir)
    expect(settings).toContain(`FLOW_DENY='${join(t.root, 'data', 'token')}'`)

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
      turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) }),
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
      turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) }),
    ])
    const run = await t.pipe.start(186278)
    await t.pipe.approve(run, { Q1: 'yes' })
    expect(t.store.state(run)!.plan!.answers).toEqual({ Q1: 'yes', Q2: 'yes' })
    expect(t.agent.prompts[1]).toContain('Q2 Log the skipped asset? → yes')
  })
  test('at the deadline: the defaults are taken by the engine (recorded as such) and the build goes on', async () => {
    const t = setup(d => [
      turn(() => writeFileSync(join(d.run, 'plan.md'), plan('- Q1: Guard the order list? — default: no'))),
      turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) }),
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
      turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) }),
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
      turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) }),
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
      turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) }),
    ], { review: [review([])] })
    const run = await t.pipe.start(186278)
    expect(t.store.state(run)).toMatchObject({ stage: 'ship', needs: { kind: 'ship' }, session: 's-1' })
    expect(t.reviewer.prompts[0]).toContain('+export const b = 2')
    expect(t.reviewer.prompts[0]).toContain('Guard the walk against missing assets.')
    expect(t.reviewers[0]).toMatchObject({ cwd: t.wt })
    expect(JSON.parse(readFileSync(join(t.runDir, 'review.json'), 'utf8'))).toMatchObject({ review: 1, findings: [], below: [], note: 'Checked.' })
  })
  test('a finding goes to the agent; after its fix, verify and review run again, then ready to ship', async () => {
    const t = setup(d => [
      turn(() => writeFileSync(join(d.run, 'plan.md'), plan())),
      turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) }),
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
      turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) }),
    ], { review: [reviewText('LGTM'), reviewText('still no json')] })
    const run = await t.pipe.start(186278)
    expect(t.reviewer.prompts[1]).toMatch(/one .*json/i)
    expect(t.store.events(run).find(e => e.type === 'review.skipped')).toMatchObject({ reason: expect.stringMatching(/review unreadable.*no JSON array/) })
    expect(t.store.state(run)).toMatchObject({ needs: { kind: 'ship' } })
  })
  test('review turned off for the project: skipped, saying so', async () => {
    const t = setup(d => [
      turn(() => writeFileSync(join(d.run, 'plan.md'), plan())),
      turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) }),
    ], { review: [], reviewOff: true })
    const run = await t.pipe.start(186278)
    expect(t.store.events(run).find(e => e.type === 'review.skipped')).toMatchObject({ reason: 'review is off for this project' })
    expect(t.reviewer.prompts).toEqual([])
  })
})

describe('port: the same fix onto another line', () => {
  const shipped = async (develop?: (main: string) => void) => {
    const t = setup(d => [
      turn(() => writeFileSync(join(d.run, 'plan.md'), plan())),
      turn(() => { writeFileSync(join(d.wt, 'src/a.ts'), 'const a = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) }),
    ], { release: true })
    develop?.(t.main)
    const run = await t.pipe.start(186278, { base: 'origin/patch/1.0' })
    await t.pipe.ship(run)
    return { t, run }
  }
  test('a new run on develop with the shipped change applied (uncommitted), verified, waiting to ship; its PR says what it ports', async () => {
    const { t, run } = await shipped()
    const port = await t.pipe.port(run, 'develop')
    expect(port).toBe('example-186278-develop')
    expect(t.store.state(port)).toMatchObject({ base: 'origin/develop', stage: 'ship', needs: { kind: 'ship' } })
    const wt = join(t.root, 'worktrees', '186278-develop', 'mobile')
    expect(readFileSync(join(wt, 'src/a.ts'), 'utf8')).toBe('const a = 2\n')
    expect(git(wt, 'branch', '--show-current')).toBe('fix/186278-develop')
    expect(git(wt, 'status', '--short')).toBe('M src/a.ts')
    await t.pipe.ship(port)
    const create = t.azCalls.filter(a => a.includes('create')).at(-1)!
    expect(create).toEqual(expect.arrayContaining(['--target-branch', 'develop', '--source-branch', 'fix/186278-develop']))
    expect(create[create.indexOf('--description') + 1]).toMatch(/^Port of #186278 PR #4711 \(patch\/1\.0\) to develop\./)
  })
  test('a conflict: the port is blocked naming the files, for you or its agent to resolve', async () => {
    const { t, run } = await shipped(main => {
      writeFileSync(join(main, 'src/a.ts'), 'const a = 9 // changed on develop meanwhile\n')
      git(main, 'commit', '-qam', 'develop moves on'); git(main, 'push', '-q', 'origin', 'HEAD:develop')
    })
    const port = await t.pipe.port(run, 'develop')
    expect(t.store.state(port)).toMatchObject({ status: 'blocked', needs: { ask: expect.stringMatching(/conflicts in src\/a\.ts/) } })
  })
  test('a run whose agent has no session yet (a port): its first message carries the ticket and the plan first', async () => {
    const { t, run } = await shipped(main => {
      writeFileSync(join(main, 'src/a.ts'), 'const a = 9 // changed on develop meanwhile\n')
      git(main, 'commit', '-qam', 'develop moves on'); git(main, 'push', '-q', 'origin', 'HEAD:develop')
    })
    const port = await t.pipe.port(run, 'develop')
    const prompts = t.agent.prompts.length
    await t.pipe.message(port, 'Resolve the conflict in src/a.ts, keeping develop\'s value.').catch(() => {})
    const first = t.agent.prompts[prompts]!
    expect(first).toContain('ticket #186278 "Asset list crashes"')
    expect(first).toContain(join(t.root, 'data', 'runs', 'example-186278-develop', 'plan.md'))
    // where it works is in its brief
    expect((t.agents.at(-1) as { appendSystemPrompt?: string }).appendSystemPrompt).toContain('fix/186278-develop')
    expect(first).toEndWith("Resolve the conflict in src/a.ts, keeping develop's value.")
  })
  test('a plan turn that died before its session began (a restart): your message carries the plan step again', async () => {
    const dead: FakeTurn = { stream: JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'killed', num_turns: 0, usage: { input_tokens: 0, output_tokens: 0 } }) }
    const t = setup(d => [dead, turn(() => writeFileSync(join(d.run, 'plan.md'), plan())), turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) })])
    const run = await t.pipe.start(186278)
    expect(t.store.state(run)?.session).toBeUndefined()
    await t.pipe.message(run, 'carry on')
    const again = t.agent.prompts[1]!
    expect(again).toContain('It crashes.')
    expect(again).toContain(join(t.runDir, 'plan.md'))
    expect(again).toEndWith('carry on')
    expect(t.store.state(run)).toMatchObject({ stage: 'ship' })
  })
  test('a build turn that died before its session began: your message carries the build step again', async () => {
    const dead: FakeTurn = { stream: JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'killed', num_turns: 0, usage: { input_tokens: 0, output_tokens: 0 } }) }
    // a plan turn that reported no session either (so the build turn is the agent's first)
    const noSession: FakeTurn = { stream: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }), effect: () => writeFileSync(join(t0.run, 'plan.md'), plan()) }
    let t0 = { run: '' }
    const t = setup(d => { t0 = d; return [noSession, dead, turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) })] })
    const run = await t.pipe.start(186278)
    expect(t.store.state(run)).toMatchObject({ stage: 'build', status: 'blocked' })
    expect(t.store.state(run)?.session).toBeUndefined()
    await t.pipe.message(run, 'carry on')
    expect(t.agent.prompts[2]!).toContain('The plan is approved.')
    expect(t.agent.prompts[2]!).toEndWith('carry on')
  })
  test('ship refuses, before pushing, a run with no PR description or one longer than the forge takes', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan())), turn(() => writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'))])
    const run = await t.pipe.start(186278)
    await expect(t.pipe.ship(run)).rejects.toThrow(/no PR description.*message it to write one/)
    writeFileSync(join(t.runDir, 'pr.md'), `# Long\n\n${'x'.repeat(4100)}\n`)
    await expect(t.pipe.ship(run)).rejects.toThrow(/4100 characters and Azure takes 4000: message the agent to cut 100/)
    expect(git(t.origin, 'branch', '--list', 'fix/186278')).toBe('')
  })
  test('only a shipped run can be ported, and only once per line', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan('- Q1: x? — default: y')))])
    const run = await t.pipe.start(186278)
    await expect(t.pipe.port(run, 'develop')).rejects.toThrow(/not shipped/)
    const s = await shipped()
    await s.t.pipe.port(s.run, 'develop')
    await expect(s.t.pipe.port(s.run, 'develop')).rejects.toThrow(/exists already/)
  })
})

describe('shared slots', () => {
  const slots = (store: EventStore) => new Resources({ agents: 1, builds: 1, devices: 1 }, {
    onWait: (run, kind) => store.append(run, 'engine', { type: 'run.waiting', resource: kind === 'builds' ? 'a build slot' : kind }),
    onGo: run => store.append(run, 'engine', { type: 'run.resumed' }),
  })
  test('the build slot is taken by another run: setup waits, saying so, and goes on when it frees', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan('- Q1: x? — default: y')))], { resources: slots })
    const other = await t.resources!.acquire('another-run', 'builds')
    setTimeout(other, 50)
    const run = await t.pipe.start(186278)
    const types = t.store.events(run).map(e => e.type)
    expect(types.slice(0, 4)).toEqual(['run.created', 'run.waiting', 'run.resumed', 'setup.done'])
    expect(t.store.events(run)[1]).toMatchObject({ resource: 'a build slot' })
    expect(t.resources!.snapshot().holders.builds).toEqual([])
  })
  test('verify holds a build slot while it runs and gives it back', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan())), turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) })], { resources: slots })
    const seen: string[][] = []
    t.resources!.onChange(s => seen.push(s.holders.builds))
    await t.pipe.start(186278)
    expect(seen.some(h => h.includes('example-186278'))).toBe(true)
    expect(t.resources!.snapshot().holders).toEqual({ agents: [], builds: [], devices: [] })
  })
  test('agent turns use the shared agent slots: a second run\'s turn waits for the first', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan('- Q1: x? — default: y')))], { resources: slots })
    const held = await t.resources!.acquire('another-run', 'agents')
    // the other run lets go once this one is seen waiting (and after 3 s at the latest, so a broken wait can't hang)
    t.store.subscribe(e => { if (e.type === 'run.waiting') held() })
    setTimeout(held, 3000)
    const run = await t.pipe.start(186278)
    expect(t.store.events(run).some(e => e.type === 'run.waiting' && e.resource === 'agents')).toBe(true)
  })
})

describe('pipeline: values from forms and tickets are checked before they reach git or a shell', () => {
  test('a base that is not a plain ref name is refused', async () => {
    const t = setup(() => [])
    for (const base of ['--upload-pack=x', 'origin/develop;rm -rf ~', 'origin/a..b', 'a b'])
      await expect(t.pipe.start(186278, { base })).rejects.toThrow(/not a branch name/)
    await expect(t.pipe.start(186278, { bases: { mobile: '-x' } })).rejects.toThrow(/not a branch name/)
  })
  test('a customer patch is two plain names', async () => {
    const t = setup(() => [])
    await expect(t.pipe.start(186278, { patch: 'acme/$(id)' })).rejects.toThrow(/--patch/)
  })
})

describe('pipeline: a message at any gate carries the run on, and flow puts the gate back', () => {
  const ready = (d: { wt: string; run: string }) => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan())), turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) })]
  test('a question at the ship gate, nothing changed: ready to ship again, without verifying again', async () => {
    const t = setup(d => [...ready(d), turn(undefined, 'I added b.')])
    const run = await t.pipe.start(186278)
    const runs = t.store.state(run)!.loops.verifyRuns
    await t.pipe.message(run, 'what did you change?')
    expect(t.store.state(run)).toMatchObject({ stage: 'ship', status: 'needs-you', needs: { kind: 'ship' }, loops: { verifyRuns: runs } })
  })
  test('a change asked for at the ship gate: verified again, then ready to ship', async () => {
    const t = setup(d => [...ready(d), turn(() => writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 3 // ERR mine\n')), turn(() => writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 3\n'))])
    const run = await t.pipe.start(186278)
    await t.pipe.message(run, 'make it 3')
    expect(t.agent.prompts[3]).toContain('ERR mine')
    expect(t.store.state(run)).toMatchObject({ stage: 'ship', needs: { kind: 'ship' } })
  })
  test('a failed turn at the ship gate blocks; the next message brings the gate back (ship works again)', async () => {
    const t = setup(d => [...ready(d), turn(() => { throw new Error('claude exited with 3') }), turn()])
    const run = await t.pipe.start(186278)
    await t.pipe.message(run, 'x')
    expect(t.store.state(run)).toMatchObject({ status: 'blocked' })
    await t.pipe.message(run, 'again')
    expect(t.store.state(run)).toMatchObject({ needs: { kind: 'ship' } })
    expect(await t.pipe.ship(run)).toHaveLength(1)
  })
  test('the verify cap: a message runs the agent and verify again (it used to stay stuck)', async () => {
    const red = (d: { wt: string }, n: number) => turn(() => writeFileSync(join(d.wt, 'src/b.ts'), `export const b = ${n} // ERR mine\n`))
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan())), red(d, 1), red(d, 2), red(d, 3), turn(() => writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 4\n'))])
    const run = await t.pipe.start(186278)
    expect(t.store.state(run)).toMatchObject({ needs: { kind: 'verify' } })
    await t.pipe.message(run, 'drop the comment')
    expect(t.store.state(run)).toMatchObject({ stage: 'ship', needs: { kind: 'ship' } })
  })
  test('the plan gate: the agent rewrites the plan after a message, and it is submitted again', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan('- Q1: Also the order list? — default: no'))),
      turn(() => writeFileSync(join(d.run, 'plan.md'), plan('- Q1: Also the order list? — default: yes\n- Q2: And the map? — default: no')))])
    const run = await t.pipe.start(186278)
    await t.pipe.message(run, 'the order list too; any more questions?')
    expect(t.store.state(run)).toMatchObject({ stage: 'plan', needs: { kind: 'plan' }, plan: { questions: [{ id: 'Q1', default: 'yes' }, { id: 'Q2' }] } })
  })
  test('changed after verify without the agent (an edit by hand): ship verifies again instead of shipping unverified code', async () => {
    const t = setup(d => [...ready(d), turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) })])
    const run = await t.pipe.start(186278)
    writeFileSync(join(t.wt, 'src/b.ts'), 'export const b = 2 // ERR by hand\n')
    expect(await t.pipe.ship(run)).toEqual([])
    expect(t.azCalls.some(a => a.includes('create'))).toBe(false)
    expect(t.agent.prompts[2]).toContain('ERR by hand')
    expect(t.store.state(run)).toMatchObject({ stage: 'ship', needs: { kind: 'ship' } })
  })
})

describe('pipeline: ship can be done again', () => {
  const ready = (d: { wt: string; run: string }) => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan())), turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) })]
  test('the push failed after the commit: shipping again pushes and opens the PR (it said "nothing to ship")', async () => {
    const t = setup(ready)
    const run = await t.pipe.start(186278)
    git(t.wt, 'remote', 'set-url', 'origin', join(t.root, 'gone.git'))
    await expect(t.pipe.ship(run)).rejects.toThrow(/push failed/)
    // the run says so (it used to show "verified" with the commit already made)
    expect(t.store.state(run)).toMatchObject({ needs: { kind: 'ship', ask: expect.stringMatching(/^ship failed: push failed.*ship again to carry on$/) } })
    git(t.wt, 'remote', 'set-url', 'origin', t.origin)
    expect(await t.pipe.ship(run)).toHaveLength(1)
    expect(git(t.origin, 'log', '-1', '--format=%s', 'fix/186278')).toMatch(/#186278/)
  })
  test('a change after the PR opened: verified again, then ship pushes it to the same PR', async () => {
    const t = setup(d => [...ready(d), turn(() => writeFileSync(join(d.wt, 'src/c.ts'), 'export const c = 1\n'))])
    const run = await t.pipe.start(186278)
    await t.pipe.ship(run)
    await t.pipe.message(run, 'also add c')
    expect(t.store.state(run)).toMatchObject({ needs: { kind: 'ship' } })
    expect(await t.pipe.ship(run)).toEqual([])
    expect(t.azCalls.filter(a => a.includes('create'))).toHaveLength(1)
    expect(git(t.origin, 'show', '--stat', '--format=', 'fix/186278')).toContain('src/c.ts')
    expect(t.store.state(run)).toMatchObject({ needs: { kind: 'pr', ask: 'review draft PR #4711' } })
  })
})

describe('pipeline: removing a run', () => {
  const ready = (d: { wt: string; run: string }) => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan())), turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) })]
  test('shipped: its worktree and local branch go, the run folder is archived, the run is gone', async () => {
    const t = setup(ready)
    const run = await t.pipe.start(186278)
    await t.pipe.ship(run)
    const r = await t.pipe.remove(run)
    expect(r.removed).toEqual([t.wt])
    expect(existsSync(t.wt)).toBe(false)
    expect(git(t.main, 'branch', '--list', 'fix/186278')).toBe('')
    expect(git(t.origin, 'branch', '--list', 'fix/186278')).toContain('fix/186278') // the PR's branch stays on origin
    expect(existsSync(t.runDir)).toBe(false)
    expect(existsSync(join(t.root, 'data', 'runs', '.removed'))).toBe(true)
    expect(t.store.state(run)).toBeUndefined()
  })
  test('work not shipped (uncommitted changes) is refused, naming the files; force removes it anyway', async () => {
    const t = setup(ready)
    const run = await t.pipe.start(186278)
    await expect(t.pipe.remove(run)).rejects.toThrow(/not shipped.*src\/b\.ts.*force/s)
    expect(existsSync(t.wt)).toBe(true)
    await t.pipe.remove(run, { force: true })
    expect(existsSync(t.wt)).toBe(false)
    expect(git(t.main, 'branch', '--list', 'fix/186278')).toBe('')
  })
  test('a failed setup is removed and the ticket can start again (it used to be used up for good)', async () => {
    const t = setup(d => ready(d))
    await expect(t.pipe.start(186278, { base: 'origin/nope' })).resolves.toBe('example-186278')
    expect(t.store.state('example-186278')).toMatchObject({ status: 'failed' })
    await t.pipe.remove('example-186278')
    expect(await t.pipe.start(186278)).toBe('example-186278')
    expect(t.store.state('example-186278')).toMatchObject({ stage: 'ship' })
  })
  test('done: a shipped run is marked done and leaves the attention list; removing can follow', async () => {
    const t = setup(ready)
    const run = await t.pipe.start(186278)
    await t.pipe.ship(run)
    t.pipe.done(run)
    expect(t.store.state(run)).toMatchObject({ stage: 'done', status: 'done' })
  })
})

describe('pipeline: what the second review found', () => {
  const ready = (d: { wt: string; run: string }) => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan())), turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) })]
  test('remove keeps a branch the run never made (setup refused it because it existed, with your commits on it)', async () => {
    const t = setup(ready)
    git(t.main, 'checkout', '-qb', 'fix/186278'); writeFileSync(join(t.main, 'mine.txt'), 'mine\n'); git(t.main, 'add', '.'); git(t.main, 'commit', '-qm', 'my own work'); git(t.main, 'checkout', '-q', 'develop')
    await t.pipe.start(186278)
    expect(t.store.state('example-186278')).toMatchObject({ status: 'failed' })
    await t.pipe.remove('example-186278')
    expect(git(t.main, 'log', '-1', '--format=%s', 'fix/186278')).toBe('my own work')
  })
  test('after a crash during verify\'s base run the change is back from its stash (it looked like "nothing to ship")', async () => {
    const t = setup(ready)
    const run = await t.pipe.start(186278)
    git(t.wt, 'stash', 'push', '--include-untracked', '-m', 'flow verify: base run')
    expect(existsSync(join(t.wt, 'src/b.ts'))).toBe(false)
    expect(await t.pipe.restoreStashes(run)).toEqual([`mobile: the change was set aside by verify when the service stopped; it is back`])
    expect(readFileSync(join(t.wt, 'src/b.ts'), 'utf8')).toBe('export const b = 2\n')
    expect(git(t.wt, 'stash', 'list')).toBe('')
  })
  test('a stash left by verify while the worktree has new changes is left alone, and said', async () => {
    const t = setup(ready)
    const run = await t.pipe.start(186278)
    git(t.wt, 'stash', 'push', '--include-untracked', '-m', 'flow verify: base run')
    writeFileSync(join(t.wt, 'src/c.ts'), 'x\n')
    expect((await t.pipe.restoreStashes(run))[0]).toMatch(/mobile: .*git stash list/)
    expect(git(t.wt, 'stash', 'list')).toContain('flow verify: base run')
  })
})

describe('pipeline: remove never takes what another run uses', () => {
  test("a worktree another run's folder names stays (a failed run pointing at its source's worktree)", async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan())), turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) })])
    const run = await t.pipe.start(186278)
    await t.pipe.ship(run)
    // a second, failed run whose run.json names the same worktree
    const other = join(t.root, 'data', 'runs', 'example-186278-x')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'run.json'), readFileSync(join(t.runDir, 'run.json')))
    t.store.append('example-186278-x', 'human', { type: 'run.created', ticket: '#186278', title: 'x', project: 'example', base: 'origin/develop' })
    t.store.append('example-186278-x', 'engine', { type: 'setup.failed', reason: 'exists already' })
    const r = await t.pipe.remove('example-186278-x')
    expect(r.removed).toEqual([])
    expect(existsSync(t.wt)).toBe(true)
    expect(git(t.main, 'branch', '--list', 'fix/186278')).toContain('fix/186278')
  })
})

describe('pipeline: the agent ends the run, or asks', () => {
  test('resolution.md at the plan step: no change needed, waiting for you; the file is kept under its own name', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'resolution.md'), '# Already fixed\n\nFixed on develop by PR #4711.\n'))])
    const run = await t.pipe.start(186278)
    expect(t.store.state(run)).toMatchObject({ stage: 'plan', status: 'needs-you', needs: { kind: 'resolution', ask: expect.stringMatching(/no change needed: Already fixed — Fixed on develop by PR #4711/) } })
    expect(existsSync(join(t.runDir, 'resolution.md'))).toBe(false)
  })
  test('blocked.md during the build: blocked with its words; a message carries it on', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan())), turn(() => writeFileSync(join(d.run, 'blocked.md'), 'I need the qa login for acme-qa.\n')),
      turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) })])
    const run = await t.pipe.start(186278)
    expect(t.store.state(run)).toMatchObject({ status: 'blocked', needs: { ask: expect.stringMatching(/I need the qa login for acme-qa/) } })
    await t.pipe.message(run, 'logins are in logins.md now')
    expect(t.store.state(run)).toMatchObject({ stage: 'ship', needs: { kind: 'ship' } })
  })
  test('a build turn that ends with a question: the run asks you instead of going to verify', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan())), turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) }, 'Changed the walk.\n\nShould I also guard the order list?')])
    const run = await t.pipe.start(186278)
    expect(t.store.state(run)).toMatchObject({ stage: 'build', status: 'needs-you', needs: { kind: 'question', ask: 'Should I also guard the order list?' } })
  })
  test('the agent gets the run brief as its system prompt, with your note and the logins file', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan('- Q1: x? — default: y')))])
    await t.pipe.start(186278, { note: 'Use order 700216740.', logins: 'qa user: tester / s3cret-pass' })
    const brief = (t.agents[0] as { appendSystemPrompt?: string }).appendSystemPrompt!
    expect(brief).toContain('Additional instructions from the human:\nUse order 700216740.')
    expect(brief).toContain(join(t.runDir, 'logins.md'))
    expect(brief).not.toContain('s3cret-pass')
    expect(require('node:fs').statSync(join(t.runDir, 'logins.md')).mode & 0o777).toBe(0o600)
  })
  test('a test login in the change or the PR description: ship refuses', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan())), turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = "s3cret-pass"\n'); writeFileSync(join(d.run, 'pr.md'), prMd) })])
    const run = await t.pipe.start(186278, { logins: 'qa user: tester / s3cret-pass' })
    await expect(t.pipe.ship(run)).rejects.toThrow(/test login.*src\/b\.ts/)
    expect(t.azCalls.some(a => a.includes('create'))).toBe(false)
  })
})

describe('pipeline: the agent\'s flow tools', () => {
  test('verify now, during the build: findings new against the base, no event recorded', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan('- Q1: x? — default: y')))])
    const run = await t.pipe.start(186278)
    writeFileSync(join(t.wt, 'src/b.ts'), 'export const b = 2 // ERR mine\n')
    const before = t.store.events(run).length
    const r = await t.pipe.callTool(run, 'verify', {})
    expect(r.text).toMatch(/1 new finding.*src\/b\.ts\|TS2322/s)
    expect(t.store.events(run)).toHaveLength(before)
  })
  test('ask through the tool: after the turn the run asks you', async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan())), turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); void t.pipe.callTool('example-186278', 'ask', { question: 'Also the tablet layout? Default: no.' }) })])
    const run = await t.pipe.start(186278)
    expect(t.store.state(run)).toMatchObject({ status: 'needs-you', needs: { kind: 'question', ask: 'Also the tablet layout? Default: no.' } })
  })
  test("a project tool runs its command with the argument as one word, in the worktree", async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan('- Q1: x? — default: y')))])
    ;(t.pipe as unknown as { d: { project: { tools: unknown[] } } }).d.project.tools = [{ name: 'echo_arg', description: 'says it back', cmd: 'printf "%s|" {word} && pwd', cwd: 'worktree', args: [{ name: 'word', description: 'w' }] }]
    const run = await t.pipe.start(186278)
    expect(t.pipe.tools(run).map(x => x.name)).toContain('echo_arg')
    const r = await t.pipe.callTool(run, 'echo_arg', { word: 'a b; rm -rf /' })
    expect(r).toMatchObject({ ok: true })
    expect(r.text).toContain('a b; rm -rf /|')
    expect(r.text).toContain(require('node:fs').realpathSync(t.wt))
  })
})

describe('pipeline: a message while the agent works', () => {
  test('is queued and goes with the agent\'s next turn, first, recorded as yours', async () => {
    let t: ReturnType<typeof setup>
    t = setup(d => [turn(() => { writeFileSync(join(d.run, 'plan.md'), plan()); t.pipe.queueMessage('example-186278', 'the tablet layout too') }), turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) })])
    const run = await t.pipe.start(186278)
    expect(t.agent.prompts[1]).toMatch(/^The human wrote while you worked:\n- the tablet layout too\n\n/)
    expect(t.store.events(run).some(e => e.type === 'human.message' && e.text === 'the tablet layout too')).toBe(true)
    expect(t.pipe.takeQueued(run)).toEqual([])
  })
})

describe('pipeline: memory and learnings', () => {
  test("the agent reads its repo's memory; what it learned goes there once you shipped, and flow's own lessons to the backlog", async () => {
    // a memory folder in your home (flow takes no other), removed after
    const mem = mkdtempSync(join(require('node:os').homedir(), '.flow-test-mem-'))
    afterAll(() => require('node:fs').rmSync(mem, { recursive: true, force: true }))
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan())), turn(() => {
      writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd)
      writeFileSync(join(d.run, 'learnings.md'), '[repo:mobile] jest: run it from the app folder\n[flow] verify: say which package failed\n')
    })])
    mkdirSync(join(t.main, '.claude'), { recursive: true }); writeFileSync(join(t.main, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: mem }))
    const run = await t.pipe.start(186278)
    expect(JSON.parse(readFileSync(t.agents[0]!.settings, 'utf8')).autoMemoryDirectory).toBe(mem)
    expect(existsSync(join(mem, 'flow-learnings.md'))).toBe(false) // not before it is shipped
    await t.pipe.ship(run)
    expect(readFileSync(join(mem, 'flow-learnings.md'), 'utf8')).toContain('- jest: run it from the app folder (example-186278)')
    expect(readFileSync(join(t.root, 'data', 'backlog.md'), 'utf8')).toContain('example-186278: verify: say which package failed')
  })
})

describe('pipeline: test logins never reach memory', () => {
  test('a learnings line with a login is dropped; the others are kept', async () => {
    // a memory folder in your home (flow takes no other), removed after
    const mem = mkdtempSync(join(require('node:os').homedir(), '.flow-test-mem-'))
    afterAll(() => require('node:fs').rmSync(mem, { recursive: true, force: true }))
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan())), turn(() => {
      writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd)
      writeFileSync(join(d.run, 'learnings.md'), '[repo:mobile] login: use tester / s3cret-pass on qa\n[repo:mobile] jest: run it from the app folder\n')
    })])
    mkdirSync(join(t.main, '.claude'), { recursive: true }); writeFileSync(join(t.main, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: mem }))
    const run = await t.pipe.start(186278, { logins: 'password: s3cret-pass' })
    await t.pipe.ship(run)
    const note = readFileSync(join(mem, 'flow-learnings.md'), 'utf8')
    expect(note).not.toContain('s3cret-pass')
    expect(note).toContain('jest: run it from the app folder')
  })
})

describe('pipeline: the reviewer', () => {
  test("gets the run's model", async () => {
    const t = setup(d => [turn(() => writeFileSync(join(d.run, 'plan.md'), plan())), turn(() => { writeFileSync(join(d.wt, 'src/b.ts'), 'export const b = 2\n'); writeFileSync(join(d.run, 'pr.md'), prMd) })], { review: [review([])] })
    await t.pipe.start(186278, { model: 'sonnet' })
    expect(t.reviewers[0]).toMatchObject({ model: 'sonnet' })
  })
})
