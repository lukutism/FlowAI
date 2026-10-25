import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseStream, type AgentEvent } from '../src/agent/stream.ts'
import { PRIVATE } from '../scripts/sanitize-recording.ts'

// Fixtures are real `claude -p --output-format stream-json --verbose` sessions on a subscription (spike/FINDINGS.md),
// sanitized for the public repo.
const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', `${name}.jsonl`), 'utf8')
const of = <K extends AgentEvent['kind']>(es: AgentEvent[], kind: K) => es.filter((e): e is Extract<AgentEvent, { kind: K }> => e.kind === kind)

describe('parseStream: the CLI event stream as the engine needs it', () => {
  test('a turn with a tool call: session, the tool and its input, the result with exact tokens', () => {
    const es = parseStream(fixture('01-turn-tool'))
    expect(of(es, 'session')[0]).toMatchObject({ session: '944ca44e-23ae-4522-b779-8be15378469e', model: 'claude-haiku-5-5', subscription: true })
    expect(of(es, 'tool')).toEqual([expect.objectContaining({ name: 'Bash', input: expect.objectContaining({ command: 'ls | wc -l' }) })])
    const r = of(es, 'result')[0]!
    expect(r).toMatchObject({ ok: true, text: '1', turns: 2 })
    expect(r.tokens.output).toBeGreaterThan(0)
    expect(r.tokens.cacheRead + r.tokens.cacheWrite + r.tokens.input).toBeGreaterThan(60_000)
  })
  test('plan usage: both windows with utilization and reset time', () => {
    const u = of(parseStream(fixture('01-turn-tool')), 'usage')[0]!
    expect(u.windows.fiveHour).toEqual({ utilization: 0.05, resetsAt: 1792875600, status: 'allowed' })
    expect(u.windows.week).toEqual({ utilization: 0.55, resetsAt: 1793080800, status: 'allowed' })
  })
  test('a tool call our hook refused, and a compaction with its token counts', () => {
    const es = parseStream(fixture('04-stream'))
    expect(of(es, 'denied')).toEqual([expect.objectContaining({ tool: 'Bash', input: expect.objectContaining({ command: 'git push origin main' }) })])
    expect(of(es, 'compaction')).toEqual([{ kind: 'compaction', trigger: 'manual', before: 25175, after: 2648 }])
  })
  test('several messages in one process: one result each, in order, same session', () => {
    const es = parseStream(fixture('03-stream-input'))
    expect(of(es, 'result').map(r => r.text)).toEqual(['OK', 'KIWI'])
    expect(new Set(of(es, 'session').map(s => s.session)).size).toBe(1)
  })
  test('a turn that ended in error is a result that is not ok, with the CLI\'s reason', () => {
    const r = of(parseStream(fixture('06-budget')), 'result')[0]!
    expect(r).toMatchObject({ ok: false, reason: 'budget_exhausted' })
  })
  test('a session that isn\'t on the subscription (an API key) is flagged, so the engine can stop before it is billed', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm', apiKeySource: 'ANTHROPIC_API_KEY' })
    expect(parseStream(line)).toEqual([{ kind: 'session', session: 's', model: 'm', subscription: false }])
  })
  test('what a tool returned, for the Agent pane: its output, and whether it failed', () => {
    const es = parseStream(fixture('01-turn-tool'))
    const tool = of(es, 'tool')[0]!
    expect(of(es, 'toolResult')).toEqual([{ kind: 'toolResult', id: tool.id, text: '       1', error: false }])
    expect(of(parseStream(fixture('04-stream')), 'toolResult').some(r => r.error && /hook error/.test(r.text))).toBe(true)
  })
  test('tool output given as blocks is joined; long output is cut; a subagent\'s own results are left out', () => {
    const line = (o: object) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', ...o }] }, parent_tool_use_id: null })
    expect(parseStream(line({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }))).toEqual([{ kind: 'toolResult', id: 't1', text: 'a\nb', error: false }])
    expect((parseStream(line({ content: 'x'.repeat(20_000) }))[0] as { text: string }).text.length).toBeLessThan(5000)
    expect(parseStream(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] }, parent_tool_use_id: 'task-1' }))).toEqual([])
  })
  test('lines that are not JSON (CLI warnings) and unknown events are skipped, not fatal', () => {
    expect(parseStream('Warning: no stdin data received\n{"type":"something_new"}\n')).toEqual([])
  })
})

describe('fixtures are safe to publish', () => {
  test('no private name or local path in any fixture', () => {
    for (const f of ['01-turn-tool', '02-resume', '03-stream-input', '04-stream', '05-after-compact', '06-budget', '07-full-profile-guard'])
      for (const p of PRIVATE) expect({ f, leak: p.test(fixture(f)) }).toEqual({ f, leak: false })
  })
})
