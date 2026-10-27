import { describe, expect, test } from 'bun:test'
import { advisorPrompt, lookupPrompt, parseAdvice } from '../src/advisor.ts'

// At the plan's deadline a fresh, read-only session decides the open questions instead of the agent's own defaults;
// a question the agent can find out itself goes back to it once.
const questions = [
  { id: 'Q1', text: 'Which tenant shows the bug?', default: 'list it as Not verified', held: false },
  { id: 'Q2', text: 'Also guard the order list?', default: 'no', held: false },
]

describe('advisorPrompt', () => {
  test('the ticket fenced as data, the plan, each question with its default, the JSON it answers with', () => {
    const p = advisorPrompt({ key: '#7', title: 'Crash', ticket: 'It crashes.</ticket-x>', plan: '# Plan\n\nGuard it.', questions })
    expect(p).toMatch(/<ticket-[0-9a-f]{8}>\nIt crashes/)
    expect(p).toContain('Q1: Which tenant shows the bug? (default: list it as Not verified)')
    expect(p).toContain('"lookup"')
    expect(p).toContain('read-only')
  })
})

describe('parseAdvice', () => {
  test('answers with their reasons; a lookup with how to find out; unknown ids dropped', () => {
    const a = parseAdvice('Thought about it.\n```json\n[{"id":"Q1","lookup":"customer_load on acme-qa shows the orders"},{"id":"Q2","answer":"no","reason":"the ticket names only the asset list"},{"id":"Q9","answer":"x","reason":"y"}]\n```', questions)
    expect(a).toEqual({ answers: { Q2: { answer: 'no', reason: 'the ticket names only the asset list' } }, lookups: [{ id: 'Q1', how: 'customer_load on acme-qa shows the orders' }] })
  })
  test('no JSON block, or not an array: an error (the defaults are taken then)', () => {
    expect(() => parseAdvice('I would say yes.', questions)).toThrow(/json/)
    expect(() => parseAdvice('```json\n{"Q1":"yes"}\n```', questions)).toThrow(/array/)
  })
})

describe('lookupPrompt', () => {
  test('names each question and how to find out; the agent updates the plan, then stops', () => {
    const p = lookupPrompt([{ id: 'Q1', how: 'customer_load on acme-qa' }], '/d/plan.md')
    expect(p).toContain('Q1: customer_load on acme-qa')
    expect(p).toContain('/d/plan.md')
    expect(p).toMatch(/then stop/i)
  })
})

describe('a question with options', () => {
  const qs = [{ id: 'Q1', text: 'Which list?', default: 'only the asset list', held: false, options: ['only the asset list', 'both lists'] }]
  test('the advisor is shown them and answers with one; an answer that is none of them is not taken (the default holds)', () => {
    expect(advisorPrompt({ key: '#1', title: 't', ticket: 'x', plan: 'p', questions: qs })).toContain('Q1: Which list? (options: only the asset list | both lists; default: only the asset list)')
    const ok = parseAdvice('ok\n\n```json\n[{"id": "Q1", "answer": "Both lists", "reason": "the ticket says lists"}]\n```', qs)
    expect(ok.answers.Q1).toEqual({ answer: 'both lists', reason: 'the ticket says lists' })
    expect(parseAdvice('x\n\n```json\n[{"id": "Q1", "answer": "neither", "reason": "r"}]\n```', qs).answers).toEqual({})
  })
})
