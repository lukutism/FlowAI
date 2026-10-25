import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAgent } from '../src/agent/fake.ts'
import type { Az } from '../src/azure.ts'
import { parseProject } from '../src/config.ts'
import { Pipeline } from '../src/pipeline.ts'
import { EventStore } from '../src/store.ts'

// What the new-run form asks before a run exists: the ticket, the bases to choose from, the customer patches and
// whether one fits the base; and the model a run is started with.
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...a: string[]) => Bun.spawnSync(['git', ...a], { cwd, env })

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'flow-form-'))
  const origin = join(root, 'o.git'), main = join(root, 'main')
  git(root, 'init', '-q', '--bare', '-b', 'develop', origin); git(root, 'clone', '-q', origin, main)
  writeFileSync(join(main, 'a.ts'), 'x\n'); git(main, 'add', '.'); git(main, 'commit', '-qm', 'b')
  for (const b of ['develop', 'patch/3.18.39', 'patch/3.18.41', 'patch/3.20.7', 'release/3.21.0']) git(main, 'push', '-q', 'origin', `HEAD:${b}`)
  git(main, 'fetch', '-q')
  const project = parseProject({
    key: 'ex', name: 'Ex', worktrees: join(root, 'wt'), tracker: { kind: 'azure', org: 'https://dev.azure.com/x', project: 'x' }, forge: { kind: 'azure', org: 'https://dev.azure.com/x', project: 'x' },
    repos: [{ key: 'mobile', path: main, defaultBase: 'origin/develop', releaseBases: ['origin/patch/*', 'origin/release/*'], verify: [], default: true,
      patches: { apply: 'true', writeBack: 'true', choices: 'printf "iwb/product\\nnordex/cmms\\n"', check: 'case "{base}" in *3.18.39) echo "{customer}/{app} 3.18.39";; *) echo "no {customer}/{app} patch for this version (newest 3.18.39)"; exit 1;; esac' } },
      { key: 'portal', path: main, defaultBase: 'origin/develop', verify: [] }],
  }, 't')
  const az: Az = args => args.includes('work-item')
    ? { code: 0, out: JSON.stringify({ fields: { 'System.Title': 'Picking quantity', 'System.WorkItemType': 'Task', 'System.TeamProject': 'iwb-hub', 'Custom.CustomerName': 'IWB', 'System.Tags': '3.18; Picking' } }), err: '' }
    : { code: 0, out: JSON.stringify({ comments: [{ createdDate: '2026-10-20', text: 'a' }, { createdDate: '2026-10-21', text: 'b' }] }), err: '' }
  const store = new EventStore(':memory:')
  const made: { model?: string }[] = []
  const pipe = new Pipeline({ store, project, az, dataDir: join(root, 'data'), gitEnv: env, makeAgent: o => { made.push(o); return new FakeAgent([]) } })
  return { pipe, store, made }
}

describe('what the new-run form asks', () => {
  test('a ticket: its title and type, its board, the customer named on it, its release tags, how many comments; whether a run exists', async () => {
    const t = setup()
    expect(await t.pipe.lookup(204598)).toEqual({ run: 'ex-204598', exists: false, key: '#204598', title: 'Picking quantity', kind: 'feature', type: 'Task', url: 'https://dev.azure.com/x/iwb-hub/_workitems/edit/204598',
      board: 'iwb-hub', customer: 'IWB', tags: ['3.18', 'Picking'], comments: 2, area: '', platform: '' })
  })
  test('bases: the default, then the release lines, newest first', () => {
    expect(setup().pipe.bases('mobile')).toEqual(['origin/develop', 'origin/release/3.21.0', 'origin/patch/3.20.7', 'origin/patch/3.18.41', 'origin/patch/3.18.39'])
    expect(setup().pipe.bases('portal')).toEqual(['origin/develop'])
  })
  test('the customer patches of the repo that has them, and whether one fits a base', async () => {
    const t = setup()
    expect(await t.pipe.patchChoices()).toEqual(['iwb/product', 'nordex/cmms'])
    expect(await t.pipe.checkPatch('iwb/product', 'origin/patch/3.18.39')).toEqual({ ok: true, text: 'iwb/product 3.18.39' })
    expect(await t.pipe.checkPatch('iwb/product', 'origin/patch/3.18.41')).toEqual({ ok: false, text: 'no iwb/product patch for this version (newest 3.18.39)' })
  })
  test('a run started with a model has its agent on that model', async () => {
    const t = setup()
    await t.pipe.start(204598, { model: 'opus' })
    expect(t.made[0]).toMatchObject({ model: 'opus' })
  })
})

import { commitMessage } from '../src/plan.ts'
import { slug } from '../src/pipeline.ts'
describe('a run without a ticket', () => {
  test('a task described instead: its run and branch named from its first line, the agent told it is not a ticket', async () => {
    const t = setup()
    const run = await t.pipe.start('', { task: 'Show the order number on the picking list\nThe technician needs it to call the office.', kind: 'feature' })
    expect(run).toBe('ex-show-the-order-number-on-the-picking')
    const s = t.store.state(run)!
    expect(s).toMatchObject({ ticket: 'task', title: 'Show the order number on the picking list' })
    const meta = JSON.parse(require('node:fs').readFileSync(join(t.pipe.runDir(run), 'run.json'), 'utf8'))
    expect(meta).toMatchObject({ branch: 'feat/show-the-order-number-on-the-picking', key: '', url: '', task: true })
    expect(require('node:fs').readFileSync(join(t.pipe.runDir(run), 'ticket.md'), 'utf8')).toContain('The technician needs it to call the office.')
  })
  test('a fix gets fix/; the name is cut at a word and kept short; the same task twice is refused', async () => {
    const t = setup()
    const run = await t.pipe.start('', { task: 'Picking: remaining quantity ignores what was already withdrawn from the reservation', kind: 'bug' })
    expect(run).toBe('ex-picking-remaining-quantity-ignores-what')
    await expect(t.pipe.start('', { task: 'Picking: remaining quantity ignores what was already withdrawn from the reservation' })).rejects.toThrow(/exists already/)
    expect(slug('  Ärger mit   "Quotes" & co!! ')).toBe('arger-mit-quotes-co')
  })
  test('its commits name no ticket', () => {
    expect(commitMessage({ id: '', title: 'Show the order number', kind: 'feature' }, ['apps/product/a.ts'], 'mobile')).toBe('feat(product): Show the order number')
  })
})

describe('the project\'s brief', () => {
  test('its lines reach the agent in the plan prompt', async () => {
    const t = setup()
    ;(t.pipe as unknown as { d: { project: { brief: string[] } } }).d.project.brief = ['the osapiens-qa MCP reads QA data: call customer_list first', 'mock data: the mobile-probe skill']
    const prompts: string[] = []
    ;(t.pipe as unknown as { d: { makeAgent: unknown } }).d.makeAgent = () => ({ async *turn(p: string) { prompts.push(p); throw new Error('stop') } })
    await t.pipe.start(204598)
    expect(prompts[0]).toContain('About this project (from the human who runs flow):\n- the osapiens-qa MCP reads QA data: call customer_list first\n- mock data: the mobile-probe skill')
  })
})
