import { describe, expect, test } from 'bun:test'
import type { Entry } from '../src/transcript.ts'
import { sessionLines } from '../src/tui/session.ts'

const text = (l: { 0: string }[][]) => l.map(x => x.map(s => s[0]).join(''))
describe('the reviewer in the Agent pane', () => {
  test('its turn is headed as the reviewer\'s, and its JSON answer reads as words, not as a raw block', () => {
    const e: Entry[] = [
      { at: 0, own: false, kind: 'tool', id: 'r1', name: 'Read', input: { file_path: 'src/a.ts' } },
      { at: 0, own: false, kind: 'text', text: 'Checked the callers.\n\n```json\n[]\n```' },
    ]
    const l = text(sessionLines(e, 100))
    expect(l[0]).toMatch(/^⏺ reviewer/)
    expect(l.join('\n')).not.toContain('[]')
    expect(l.join('\n')).toContain('found nothing at 80% or more')
  })
  test('findings are listed, one a line', () => {
    const f = [{ severity: 'P1', file: 'src/a.ts', line: 4, problem: 'the order list is not guarded', confidence: 90 }]
    const l = text(sessionLines([{ at: 0, own: false, kind: 'text', text: `Found one.\n\n\`\`\`json\n${JSON.stringify(f)}\n\`\`\`` }], 100)).join('\n')
    expect(l).toContain('1 finding: [P1] src/a.ts:4 the order list is not guarded (90%)')
  })
})
