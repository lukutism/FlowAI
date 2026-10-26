import { describe, expect, test } from 'bun:test'
import { changes, fields, get, itemsMap, mapItems, set, shown } from '../src/tui/settings-model.ts'

// A project's settings as the screen edits them: fields over the file, set by path, the changes for the save.
const json = {
  key: 'fso', name: 'FSO', worktrees: '~/fso/.flow/worktrees',
  tracker: { kind: 'azure', org: 'https://dev.azure.com/o', project: 'product-app' }, forge: { kind: 'azure', org: 'https://dev.azure.com/o', project: 'product-app' },
  repos: [{ key: 'mobile', path: '~/fso/m', defaultBase: 'origin/develop', releaseBases: ['origin/patch/*'], verify: [{ name: 'tsc', kind: 'tsc', cmd: 'tsc' }], patches: { apply: 'a', writeBack: 'w' } },
    { key: 'portal', path: '~/fso/p', defaultBase: 'origin/develop', verify: [] }],
  sandbox: { enabled: true, allowUnsandboxedCommands: false, filesystem: { allowWrite: ['~/.npm', '~/.crit'] } },
  patchApps: { product: 'picking|material' },
}

describe('settings: values by path', () => {
  test('get and set; set leaves the rest as it was and makes what is missing', () => {
    expect(get(json, ['repos', 0, 'verify', 0, 'cmd'])).toBe('tsc')
    const j = set(json, ['plan', 'deadlineMinutes'], 45)
    expect((j as Record<string, unknown>).plan).toEqual({ deadlineMinutes: 45 })
    expect((json as Record<string, unknown>).plan).toBeUndefined()
    expect(set(json, ['name'], undefined)).not.toHaveProperty('name')
  })
  test('a field shows the file\'s value, else what is used when it says nothing', () => {
    const f = fields('Agents & limits', json).find(x => x.label === 'Plan deadline')!
    expect(shown(f, json)).toBe(30)
    expect(shown(f, set(json, ['plan', 'deadlineMinutes'], 45))).toBe(45)
  })
  test('a map as list items and back', () => {
    expect(mapItems(json.patchApps)).toEqual(['product=picking|material'])
    expect(itemsMap(['product=picking|material', 'cmms = maintenance', 'broken'])).toEqual({ product: 'picking|material', cmms: 'maintenance' })
  })
})

describe('settings: the sections', () => {
  test('Repos shows the chosen repo: its checks, its patch commands, a dev server to add when it has none', () => {
    const m = fields('Repos', json, 0)
    expect(m.find(f => f.label === 'tsc (tsc)')?.path).toEqual(['repos', 0, 'verify', 0, 'cmd'])
    expect(m.find(f => f.label === 'Apply')?.path).toEqual(['repos', 0, 'patches', 'apply'])
    expect(m.find(f => f.kind === 'add')?.label).toBe('Add a dev server')
    expect(fields('Repos', json, 1).find(f => f.label === 'Apply')).toBeUndefined()
  })
  test('Permissions: the guard locked, the sandbox editable (stay inside shown the right way round)', () => {
    const p = fields('Permissions', json)
    expect(p.filter(f => f.kind === 'locked')).toHaveLength(3)
    const inside = p.find(f => f.label === 'Stay inside')!
    expect(inside).toMatchObject({ kind: 'toggle', invert: true, path: ['sandbox', 'allowUnsandboxedCommands'] })
    expect(p.find(f => f.label === 'Writable')).toMatchObject({ kind: 'list' })
  })
  test('Tickets & PRs follow the tracker and forge: Jira and GitHub have their own fields', () => {
    const jira = { ...json, tracker: { kind: 'jira', site: 's', key: 'SGL', email: 'e' }, forge: { kind: 'github', owner: 'me' } }
    expect(fields('Tickets & PRs', jira).map(f => f.label)).toEqual(['Tickets', 'Site', 'Project key', 'Email', 'Keychain item', 'Pull requests', 'Owner', 'Commits', 'Name', 'Email'])
  })
  test("Commits: the name and email flow commits under; both emptied, the project falls back to the global git identity", () => {
    const f = fields('Tickets & PRs', json)
    expect(f.filter(x => x.path?.[0] === 'commitAs').map(x => x.path)).toEqual([['commitAs', 'name'], ['commitAs', 'email']])
    const { parseProject } = require('../src/config.ts') as typeof import('../src/config.ts')
    const base = { key: 'ex', name: 'Ex', worktrees: '/w', tracker: { kind: 'azure', org: 'https://dev.azure.com/x', project: 'x' }, forge: { kind: 'azure', org: 'https://dev.azure.com/x', project: 'x' }, repos: [{ key: 'm', path: '/m', defaultBase: 'origin/develop', verify: [] }] }
    expect(parseProject({ ...base, commitAs: {} }, 't').commitAs).toBeUndefined()
    expect(parseProject({ ...base, commitAs: { name: 'Me', email: 'me@example.com' } }, 't').commitAs).toEqual({ name: 'Me', email: 'me@example.com' })
    expect(() => parseProject({ ...base, commitAs: { email: 'me@example.com' } }, 't')).toThrow(/commitAs/)
  })
})

describe('settings: the changes, for the save review', () => {
  test('a value changed, a list\'s items added and removed, repos named by their key', () => {
    let j = set(json, ['plan', 'deadlineMinutes'], 45)
    j = set(j, ['sandbox', 'filesystem', 'allowWrite'], ['~/.npm', '~/.m2'])
    j = set(j, ['repos', 1, 'install'], 'npm ci')
    expect(changes(json, j)).toEqual([
      { where: 'repos.portal.install', before: undefined, after: 'npm ci' },
      { where: 'sandbox.filesystem.allowWrite', added: ['~/.m2'], removed: ['~/.crit'] },
      { where: 'plan', before: undefined, after: { deadlineMinutes: 45 } },
    ])
    expect(changes(json, json)).toEqual([])
  })
})
