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
