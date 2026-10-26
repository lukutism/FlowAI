import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryDir, saveLearnings, splitLearnings } from '../src/learnings.ts'

// What an agent learned that the next one would otherwise get wrong: kept in its repo's Claude memory (where every
// later agent of that repo reads it), and what it found wrong with flow in flow's own backlog.
describe('learnings', () => {
  test('lines tagged by repo or flow; anything else is left out', () => {
    expect(splitLearnings('- [repo:mobile] jest: run it from the app folder\n[flow] the device tool: relaunch needs the app id\nnoise\n[repo:portal] x')).toEqual({ repos: { mobile: ['jest: run it from the app folder'], portal: ['x'] }, flow: ['the device tool: relaunch needs the app id'] })
  })
  test("a repo's memory: its own setting, else Claude Code's folder for its path", () => {
    const repo = mkdtempSync(join(tmpdir(), 'flow-mem-'))
    expect(memoryDir(repo)).toBe(join(require('node:os').homedir(), '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'), 'memory'))
    mkdirSync(join(repo, '.claude')); writeFileSync(join(repo, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: '/m/x' }))
    expect(memoryDir(repo)).toBe('/m/x')
  })
  test("saved under the run's name: a note plus its index line; saving again replaces that run's lines", () => {
    const mem = mkdtempSync(join(tmpdir(), 'flow-mem-')), backlog = join(mem, 'backlog.md')
    saveLearnings({ run: 'fso-1', text: '[repo:mobile] a\n[repo:mobile] b\n[flow] c', memory: () => mem, backlog })
    saveLearnings({ run: 'fso-1', text: '[repo:mobile] a, better\n[flow] c', memory: () => mem, backlog })
    const note = readFileSync(join(mem, 'flow-learnings.md'), 'utf8')
    expect(note).toMatch(/^---\nname: flow-learnings/)
    expect(note).toContain('- a, better (fso-1)')
    expect(note).not.toContain('- b (fso-1)')
    expect(readFileSync(join(mem, 'MEMORY.md'), 'utf8')).toContain('[flow learnings](flow-learnings.md)')
    expect(readFileSync(backlog, 'utf8')).toContain('fso-1: c')
  })
})
