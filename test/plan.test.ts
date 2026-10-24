import { describe, expect, test } from 'bun:test'
import { commitMessage, parsePlan } from '../src/plan.ts'

// The agent writes plan.md in the run folder; flow reads the summary and the open questions out of it.
const plan = (questions: string) => `# Plan

Selectors keyed per asset keep every copy they saw; clear them when the shown asset changes.

## Approach
- clear the caches in useAssetsEffect

## Open questions
${questions}
`

describe('parsePlan', () => {
  test('the summary is the first paragraph; each question has its default; (held) marks a behaviour decision', () => {
    const p = parsePlan(plan(['- Q1: Also clear on order switch? — default: yes', '- Q2 (held): Drop the extension-field refresh? — default: no'].join('\n')))
    expect(p.summary).toBe('Selectors keyed per asset keep every copy they saw; clear them when the shown asset changes.')
    expect(p.questions).toEqual([
      { id: 'Q1', text: 'Also clear on order switch?', default: 'yes', held: false },
      { id: 'Q2', text: 'Drop the extension-field refresh?', default: 'no', held: true },
    ])
  })
  test('"none" (with or without a reason) means no questions; so does a missing section', () => {
    expect(parsePlan(plan('none — the ticket says what to do')).questions).toEqual([])
    expect(parsePlan('# Plan\n\nJust do it.\n').questions).toEqual([])
  })
  test('a question without a default is an error the agent can fix: flow can\'t decide it at the deadline', () => {
    expect(() => parsePlan(plan('- Q1: Which tenant?'))).toThrow(/Q1 has no default/)
  })
  test('ids are made up when the agent left them out', () => {
    expect(parsePlan(plan('- Keep the old payload? — default: yes')).questions[0]).toMatchObject({ id: 'Q1', text: 'Keep the old payload?' })
  })
})

describe('commitMessage: conventional, with the ticket, within commitlint\'s 100 characters', () => {
  test('type from the ticket kind, scope from the one app touched', () => {
    expect(commitMessage({ id: 186278, title: 'Fix asset list memory crash', kind: 'bug' }, ['apps/cmms/models/assets.ts', 'apps/cmms/hooks/x.ts'], 'mobile'))
      .toBe('fix(cmms): #186278 Fix asset list memory crash')
  })
  test('several apps touched: the repo is the scope; features are feat', () => {
    expect(commitMessage({ id: 1, title: 'Add export', kind: 'feature' }, ['apps/a/x.ts', 'packages/b/y.ts'], 'mobile')).toBe('feat(mobile): #1 Add export')
  })
  test('a colon in the title would end the header for commitlint: it becomes a dash; no trailing full stop', () => {
    expect(commitMessage({ id: 2, title: 'Asset list: crash on save.', kind: 'bug' }, [], 'mobile')).toBe('fix(mobile): #2 Asset list - crash on save')
  })
  test('long titles are cut at a word, with an ellipsis, to 100 characters', () => {
    const m = commitMessage({ id: 3, title: 'word '.repeat(40), kind: 'bug' }, [], 'mobile')
    expect(m.length).toBeLessThanOrEqual(100)
    expect(m).toEndWith('word…')
  })
})
