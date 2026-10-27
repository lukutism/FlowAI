import { describe, expect, test } from 'bun:test'
import { parseLine } from '../src/agent/stream.ts'
import { Ingest } from '../src/ingest.ts'
import { EventStore } from '../src/store.ts'

// A turn's tokens are kept as it goes, so a turn cut off (flow restarted, the process killed) still counts; the
// result's total stays the figure when it comes.
const step = (id: string, input: number, session = 's1') => parseLine(JSON.stringify({ type: 'assistant', session_id: session, parent_tool_use_id: null, message: { id, content: [{ type: 'text', text: 'x' }], usage: { input_tokens: input, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } }))
const result = (input: number, output: number, session = 's1') => parseLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, session_id: session, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 50000 } }))

describe('tokens as a turn goes', () => {
  test('each model call counts once (its blocks repeat it), written every 20 calls; the result adds what is left', () => {
    const store = new EventStore(':memory:'), ing = new Ingest(store)
    store.append('r', 'human', { type: 'run.created', ticket: '#1', title: 't', project: 'p', base: 'b' })
    for (let i = 0; i < 45; i++) for (const e of [...step(`m${i}`, 100), ...step(`m${i}`, 100)]) ing.agent('r', e)
    const used = () => store.events('r').filter(e => e.type === 'tokens.used') as { tokens: number; cached?: number }[]
    expect(used().map(e => e.tokens)).toEqual([2200, 2200]) // 2 × 20 calls of 110, before the turn ends
    for (const e of result(4500, 450)) ing.agent('r', e)
    expect(used().reduce((n, e) => n + e.tokens, 0)).toBe(4950) // the result's total, not more
  })
  test("a reviewer's session beside the agent's is kept apart", () => {
    const store = new EventStore(':memory:'), ing = new Ingest(store)
    store.append('r', 'human', { type: 'run.created', ticket: '#1', title: 't', project: 'p', base: 'b' })
    for (let i = 0; i < 20; i++) { for (const e of step(`a${i}`, 100, 's1')) ing.agent('r', e); for (const e of step(`b${i}`, 100, 's2')) ing.agent('r', e) }
    for (const e of result(2000, 200, 's2')) ing.agent('r', e)
    const used = store.events('r').filter(e => e.type === 'tokens.used') as { tokens: number }[]
    expect(used.reduce((n, e) => n + e.tokens, 0)).toBe(2200 + 2200) // s1's 20 calls written; s2 the result's total
  })
})
