import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAgent, type FakeTurn } from '../src/agent/fake.ts'
import { parseProject } from '../src/config.ts'
import type { Forge } from '../src/forge.ts'
import { Pipeline } from '../src/pipeline.ts'
import { EventStore } from '../src/store.ts'
import type { Tracker } from '../src/tracker.ts'

// A Jira + GitHub project with its own naming (spk's): the branch and the PR title are the key, the commit is
// "<key> <summary>", the PR body is the ticket link.
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...a: string[]) => new TextDecoder().decode(Bun.spawnSync(['git', ...a], { cwd, env }).stdout).trim()
const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm', apiKeySource: 'none' })
const turn = (effect?: () => void): FakeTurn => ({ stream: `${init}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, session_id: 's', usage: {} })}`, effect })

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'flow-naming-'))
  const origin = join(root, 'spk-web-app.git'), main = join(root, 'web')
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'main', origin])
  Bun.spawnSync(['git', 'clone', '-q', origin, main], { env })
  writeFileSync(join(main, 'a.ts'), 'x\n'); git(main, 'add', '.'); git(main, 'commit', '-qm', 'base'); git(main, 'push', '-q', 'origin', 'HEAD:main')
  const project = parseProject({
    key: 'spk', name: 'SPK', worktrees: join(root, 'wt'),
    tracker: { kind: 'jira', site: 'https://example.atlassian.net', key: 'SGL', email: 'me@example.com' }, forge: { kind: 'github', owner: 'OWNER' },
    naming: { branch: '{key}', commit: 'key-summary', prTitle: 'key', prBody: 'ticket-link' },
    repos: [{ key: 'web', path: main, defaultBase: 'origin/main', verify: [] }], review: { enabled: false },
  }, 't')
  const tracker: Tracker = {
    parseKey: a => (/^SGL-\d+$/i.test(a) ? { id: a.toUpperCase(), key: a.toUpperCase() } : null),
    read: async id => ({ id, key: String(id), title: 'New success modal text', kind: 'feature', url: `https://example.atlassian.net/browse/${id}`, text: 'Show Ačiū.' }),
  }
  const prs: Parameters<Forge['draftPr']>[0][] = []
  const forge: Forge = { draftPr: o => { prs.push(o); return { number: 57, url: 'https://github.com/OWNER/spk-web-app/pull/57' } }, prState: () => 'open' }
  const data = join(root, 'data'), run = join(data, 'runs', 'spk-SGL-692')
  const agent = new FakeAgent([
    turn(() => { mkdirSync(run, { recursive: true }); writeFileSync(join(run, 'plan.md'), '# Plan\n\nChange the text.\n\n## Open questions\nnone\n') }),
    turn(() => { writeFileSync(join(root, 'wt', 'SGL-692', 'web', 'a.ts'), 'y\n'); writeFileSync(join(run, 'pr.md'), '# Show the new success text\n\nDetails.\n') }),
  ])
  const pipe = new Pipeline({ store: new EventStore(':memory:'), project, az: () => ({ code: 1, out: '', err: '' }), dataDir: data, gitEnv: env, tracker, forge, makeAgent: () => agent })
  return { pipe, prs, origin }
}

describe('a Jira + GitHub project with its own naming', () => {
  test('run and branch named by the key; the commit "<key> <summary>"; the PR titled by the key, its body the ticket link', async () => {
    const t = setup()
    const run = await t.pipe.start('sgl-692')
    expect(run).toBe('spk-SGL-692')
    await t.pipe.ship(run)
    expect(git(t.origin, 'log', '-1', '--format=%s', 'SGL-692')).toBe('SGL-692 Show the new success text')
    expect(t.prs).toEqual([{ repository: 'spk-web-app', head: 'SGL-692', base: 'main', title: 'SGL-692', body: 'https://example.atlassian.net/browse/SGL-692' }])
  })
  test('something that is not one of the project\'s keys is refused, saying what a key looks like', async () => {
    await expect(setup().pipe.start('692')).rejects.toThrow(/692 is not a ticket of project spk \(SGL-<number>\)/)
  })
})
