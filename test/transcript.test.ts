import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendTranscript, readTranscript, tail } from '../src/transcript.ts'

// The transcript is what the Agent pane shows; whole files written by the agent are not worth keeping in it.
describe('the transcript keeps what the pane shows', () => {
  test('a tool\'s long inputs (a whole file for Write) are cut, saying how long they were', () => {
    const d = mkdtempSync(join(tmpdir(), 'flow-tr-'))
    appendTranscript(d, 'r', { at: 1, own: true, kind: 'tool', id: 't', name: 'Write', input: { file_path: 'src/a.ts', content: 'x'.repeat(50_000) } })
    const [e] = readTranscript(d, 'r')
    expect(e).toMatchObject({ kind: 'tool', input: { file_path: 'src/a.ts' } })
    const content = (e as unknown as { input: { content: string } }).input.content
    expect(content.length).toBeLessThan(1200)
    expect(content).toMatch(/50000 characters/)
    expect(readFileSync(join(d, 'runs', 'r', 'transcript.jsonl'), 'utf8').length).toBeLessThan(2000)
  })
})

describe('a log\'s last lines', () => {
  test('read from the end of a large file: the last n, whole', () => {
    const d = mkdtempSync(join(tmpdir(), 'flow-tail-')), f = join(d, 'metro.log')
    require('node:fs').writeFileSync(f, Array.from({ length: 50_000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n') + '\n\n')
    const t = tail(f, 3)
    expect(t).toEqual([49_997, 49_998, 49_999].map(i => `line ${i} ${'x'.repeat(40)}`))
  })
})
