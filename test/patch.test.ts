import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAgent, type FakeTurn } from '../src/agent/fake.ts'
import type { Az } from '../src/azure.ts'
import { parseProject } from '../src/config.ts'
import { Pipeline } from '../src/pipeline.ts'
import { EventStore } from '../src/store.ts'
import { fullPlan } from './plans.ts'

// A customer patch run: the patch applied at setup as a local commit (never pushed), so verify and review see only
// the fix; ship writes the patch back (a dry run first, then for real) instead of opening a PR.
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...a: string[]) => new TextDecoder().decode(Bun.spawnSync(['git', ...a], { cwd, env }).stdout).trim()
const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm', apiKeySource: 'none' })
const turn = (effect?: () => void): FakeTurn => ({ stream: `${init}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, session_id: 's', usage: {} })}`, effect })

function setup(o: { apply?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flow-patch-'))
  const origin = join(root, 'o.git'), main = join(root, 'main'), marks = join(root, 'marks')
  mkdirSync(marks)
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'develop', origin]); Bun.spawnSync(['git', 'clone', '-q', origin, main], { env })
  writeFileSync(join(main, 'a.ts'), 'x\n'); writeFileSync(join(main, 'theme.ts'), 'blue\n'); writeFileSync(join(main, '.gitignore'), 'ignored/\n')
  git(main, 'add', '.'); git(main, 'commit', '-qm', 'b'); git(main, 'push', '-q', 'origin', 'HEAD:develop')
  // the customer's patch: theme.ts red, a new logo file; "fails" lints anything on theme.ts so a patch line would show up as new
  const project = parseProject({
    key: 'ex', name: 'Ex', worktrees: join(root, 'wt'), tracker: { kind: 'azure', org: 'https://dev.azure.com/x', project: 'x' }, forge: { kind: 'azure', org: 'https://dev.azure.com/x', project: 'x' },
    repos: [{ key: 'mobile', path: main, defaultBase: 'origin/develop',
      verify: [{ name: 'no-red', kind: 'command', cmd: '! grep -q red theme.ts' }],
      patches: {
        apply: o.apply ?? `echo red > theme.ts && echo logo > logo.svg && git add theme.ts logo.svg && echo "{customer}/{app} patch 1.2.3 from {base}"`,
        writeBack: `git diff HEAD --stat > ${marks}/seen-{dryRun} && git status --porcelain > ${marks}/status-{dryRun} && echo "wrote {customer}/{app} {dryRun}"`,
      } }],
    review: { enabled: false },
  }, 't')
  const az: Az = args => args.includes('work-item') ? { code: 0, out: JSON.stringify({ fields: { 'System.Title': 'T', 'System.WorkItemType': 'Bug' } }), err: '' }
    : args.includes('create') ? { code: 0, out: '{"pullRequestId": 9}', err: '' } : { code: 0, out: '{"comments":[]}', err: '' }
  const data = join(root, 'data'), run = join(data, 'runs', 'ex-5'), wt = join(root, 'wt', '5', 'mobile')
  const agent = new FakeAgent([
    turn(() => { mkdirSync(run, { recursive: true }); writeFileSync(join(run, 'plan.md'), fullPlan()) }),
    turn(() => { writeFileSync(join(wt, 'a.ts'), 'y\n'); writeFileSync(join(wt, 'helper.ts'), 'h\n') }),
  ])
  const store = new EventStore(':memory:')
  const made: unknown[] = []
  const pipe = new Pipeline({ store, project, az, dataDir: data, gitEnv: env, makeAgent: o => { made.push(o); return agent } })
  return { made, pipe, store, agent, marks, run, wt, origin, az }
}

describe('a customer patch run', () => {
  test('setup applies the patch as a local commit; verify and the agent see only the fix', async () => {
    const t = setup()
    const run = await t.pipe.start(5, { patch: 'acme/product' })
    expect(t.store.events(run).find(e => e.type === 'patch.applied')).toMatchObject({ customer: 'acme', app: 'product', summary: 'acme/product patch 1.2.3 from origin/develop' })
    expect(git(t.wt, 'log', '-1', '--format=%s')).toBe('customer patch acme/product (local to flow, never pushed)')
    expect(git(t.wt, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['logo.svg', 'theme.ts'])
    // the patch's red theme is in the base of the comparison, so the step is not a new finding
    expect(t.store.state(run)).toMatchObject({ stage: 'ship', needs: { kind: 'ship' }, patch: { customer: 'acme', app: 'product' } })
    expect((t.made[0] as { appendSystemPrompt?: string }).appendSystemPrompt).toContain('Customer patch acme/product is applied as a local commit')
  })
  test('ship: a dry run of the write-back with the whole change (patch, fix, new files), nothing committed or pushed; the worktree as before', async () => {
    const t = setup()
    const run = await t.pipe.start(5, { patch: 'acme/product' })
    const head = git(t.wt, 'rev-parse', 'HEAD')
    await t.pipe.ship(run)
    const seen = readFileSync(join(t.marks, 'seen---dry-run'), 'utf8')
    for (const f of ['theme.ts', 'logo.svg', 'a.ts', 'helper.ts']) expect(seen).toContain(f)
    expect(t.store.state(run)).toMatchObject({ needs: { kind: 'patch', ask: expect.stringContaining('ship again to write the patch back') } })
    expect(readFileSync(join(t.run, 'patch-report.txt'), 'utf8')).toContain('wrote acme/product --dry-run')
    expect(git(t.wt, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(t.wt, 'status', '--porcelain').split('\n').map(l => l.trim()).sort()).toEqual(['?? helper.ts', 'M a.ts'])
    expect(git(t.wt, 'diff', '--cached', '--name-only')).toBe('') // nothing left staged, no intent-to-add entries
    expect(git(t.origin, 'branch', '--list', '--format=%(refname:short)')).toBe('develop')
    expect(t.store.events(run).some(e => e.type === 'pr.opened')).toBe(false)
  })
  test('ship again: the write-back for real, and the run is done', async () => {
    const t = setup()
    const run = await t.pipe.start(5, { patch: 'acme/product' })
    await t.pipe.ship(run)
    await t.pipe.ship(run)
    expect(existsSync(join(t.marks, 'seen-'))).toBe(true)
    expect(t.store.state(run)).toMatchObject({ stage: 'done', status: 'done' })
    expect(t.store.events(run).find(e => e.type === 'patch.written')).toMatchObject({ report: expect.stringContaining('wrote acme/product') })
    await expect(t.pipe.ship(run)).rejects.toThrow(/not ready to ship/)
  })
  test('a patch that does not apply fails the setup with its words', async () => {
    const t = setup({ apply: 'echo "no acme/product patch for 9.9.9 (has 1.2.3)" >&2; exit 1' })
    const run = await t.pipe.start(5, { patch: 'acme/product' })
    expect(t.store.state(run)).toMatchObject({ status: 'failed', needs: { kind: 'setup', ask: expect.stringContaining('patch: no acme/product patch for 9.9.9 (has 1.2.3)') } })
  })
  test('a patch run needs a repo with patch commands, and customer/app', async () => {
    const t = setup()
    await expect(t.pipe.start(5, { patch: 'acme' })).rejects.toThrow(/<customer>\/<app>/)
    ;(t.pipe as unknown as { d: { project: { repos: { patches?: unknown }[] } } }).d.project.repos[0]!.patches = undefined
    await expect(t.pipe.start(5, { patch: 'acme/product' })).rejects.toThrow(/no repo .*patch commands/)
  })
})
