import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadProject, parseProject } from '../src/config.ts'

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
