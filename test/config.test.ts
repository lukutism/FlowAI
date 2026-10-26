import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadProject, loadSettings, parseProject } from '../src/config.ts'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const example = join(import.meta.dir, 'fixtures', 'project.example.json')

describe('project config: one file per project, checked when flow starts', () => {
  test('the example loads; ~ means the home folder; defaults are filled in', () => {
    const p = loadProject(example)
    expect(p.key).toBe('example')
    expect(p.repos[0]!.path).toBe(join(homedir(), 'work/example/mobile'))
    expect(p.repos[0]!.verify.map(v => v.kind)).toEqual(['tsc', 'eslint', 'jest'])
    expect(p.agent).toEqual({ cli: 'claude', maxParallel: 2 })
    expect(p.usage).toEqual({ fiveHour: 0.9, week: 0.95 })
  })
  test('a mistake names the field and what is wrong, so the fix is obvious', () => {
    const bad = { ...JSON.parse(require('node:fs').readFileSync(example, 'utf8')), repos: [{ key: 'mobile', defaultBase: 'origin/develop', verify: [] }] }
    expect(() => parseProject(bad, 'fso.json')).toThrow(/fso\.json: repos\.0\.path: Required/)
  })
  test('unknown tracker kinds are refused rather than guessed', () => {
    const bad = { ...JSON.parse(require('node:fs').readFileSync(example, 'utf8')), tracker: { kind: 'trello' } }
    expect(() => parseProject(bad, 'x.json')).toThrow(/tracker/)
  })
})

describe('flow.json: settings for the whole machine', () => {
  test('no file: the default limits (2 agents, 2 builds, 4 devices), notifications on', () => {
    expect(loadSettings(join(tmpdir(), 'no-such-flow.json'))).toEqual({ limits: { agents: 2, builds: 2, devices: 4 }, notify: true })
  })
  test('a partial file keeps the other defaults', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'flow-set-')), 'flow.json')
    writeFileSync(f, JSON.stringify({ limits: { agents: 3 } }))
    expect(loadSettings(f)).toEqual({ limits: { agents: 3, builds: 2, devices: 4 }, notify: true })
  })
  test('a wrong value names itself', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'flow-set-')), 'flow.json')
    writeFileSync(f, JSON.stringify({ limits: { builds: 0 } }))
    expect(() => loadSettings(f)).toThrow(/limits\.builds/)
  })
})

describe('project tools: their commands keep arguments as data', () => {
  const base = { key: 'x', name: 'X', worktrees: '/w', tracker: { kind: 'azure', org: 'https://dev.azure.com/o', project: 'p' }, forge: { kind: 'azure', org: 'https://dev.azure.com/o', project: 'p' }, repos: [{ key: 'm', path: '/m', defaultBase: 'origin/develop', verify: [] }] }
  const tool = (cmd: string, args = [{ name: 'q', description: 'd' }]) => ({ ...base, tools: [{ name: 'find_it', description: 'd', cmd, args }] })
  test('a placeholder inside quotes is refused (the quoting would be undone: "{q}" with $(…) in it runs it)', () => {
    expect(() => parseProject(tool('grep "{q}" .'), 'x.json')).toThrow(/quotes/)
    expect(() => parseProject(tool("grep '{q}' ."), 'x.json')).toThrow(/quotes/)
    expect(parseProject(tool('grep -- {q} .'), 'x.json').tools[0]!.cmd).toBe('grep -- {q} .')
  })
  test("an argument can't take a built-in's name (it would replace {worktree} or {run})", () => {
    expect(() => parseProject(tool('ls {worktree}', [{ name: 'worktree', description: 'd' }]), 'x.json')).toThrow(/built-in/)
  })
})
