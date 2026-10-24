import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changeText, parseFindings } from '../src/review.ts'

// The reviewer answers with a JSON array; flow keeps findings it is at least 80% sure of.
describe('parseFindings', () => {
  const f = (o: object) => ({ severity: 'P1' as const, file: 'src/a.ts', line: 3, problem: 'p', evidence: 'e', confidence: 90, ...o })
  test('the last ```json block of the answer; low-confidence findings dropped', () => {
    const text = `Looked at it.\n\n\`\`\`json\n${JSON.stringify([f({ problem: 'kept' }), f({ problem: 'dropped', confidence: 60 })])}\n\`\`\``
    expect(parseFindings(text)).toEqual({ findings: [f({ problem: 'kept' })], dropped: 1 })
  })
  test('an empty array: nothing found', () => {
    expect(parseFindings('```json\n[]\n```')).toEqual({ findings: [], dropped: 0 })
  })
  test('a bare array without a fence is read too', () => {
    expect(parseFindings(JSON.stringify([f({})])).findings).toHaveLength(1)
  })
  test('no array, or items missing fields: unreadable (flow asks once more), never "nothing found"', () => {
    expect(() => parseFindings('Looks good to me!')).toThrow(/no JSON array/)
    expect(() => parseFindings('```json\n[{"problem":"x"}]\n```')).toThrow(/finding 1/)
  })
})

describe('changeText: the change as the reviewer sees it', () => {
  test('the diff against the base plus new files in full; ignored files left out', () => {
    const wt = mkdtempSync(join(tmpdir(), 'flow-rev-'))
    const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: wt, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
    writeFileSync(join(wt, 'a.ts'), 'const a = 1\n'); writeFileSync(join(wt, '.gitignore'), 'node_modules/\n')
    git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base')
    writeFileSync(join(wt, 'a.ts'), 'const a = 2\n'); writeFileSync(join(wt, 'b.ts'), 'export const b = 1\n')
    mkdirSync(join(wt, 'node_modules')); writeFileSync(join(wt, 'node_modules', 'x.js'), 'ignored')
    const text = changeText(wt)
    expect(text).toContain('-const a = 1\n+const a = 2')
    expect(text).toContain('new file b.ts')
    expect(text).toContain('+export const b = 1')
    expect(text).not.toContain('ignored')
  })
})
