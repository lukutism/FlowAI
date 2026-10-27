import { describe, expect, test } from 'bun:test'
import { commitMessage, parsePlan, planFacts, planGaps, prSummary } from '../src/plan.ts'
import { fullPlan } from './plans.ts'

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
  test('a question with its options: the default is one of them (its reason kept apart); a default that is none of them is an error', () => {
    const p = parsePlan(plan('- Q1: Which list gets the guard? — options: only the asset list | both lists | none — default: Only the asset list because the ticket names it'))
    expect(p.questions).toEqual([{ id: 'Q1', text: 'Which list gets the guard?', options: ['only the asset list', 'both lists', 'none'], default: 'only the asset list', why: 'the ticket names it', held: false }])
    expect(() => parsePlan(plan('- Q1: Which? — options: a | b — default: c'))).toThrow(/Q1's default "c" is not one of its options \(a, b\)/)
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

describe('planGaps: what the plan still lacks (the agent is asked once to fill it in)', () => {
  const bug = { bug: true, releaseLines: true }
  test('a complete plan lacks nothing; "- none — why" is no question', () => {
    expect(planGaps(fullPlan(), bug)).toEqual([])
    expect(parsePlan(fullPlan()).questions).toEqual([])
  })
  test('each missing part is named, with the form it takes', () => {
    const g = planGaps('# Plan\n\nDo it.\n\n## Open questions\nnone\n', bug)
    for (const part of ['Repro', 'Target lines', 'PR extras', 'Problem', 'Design choice', 'Acceptance criteria', 'Unchanged behavior', 'Open questions: none — say why nothing is open']) expect(g.join('\n')).toContain(part)
  })
  test('a feature needs no Repro, a project without release lines no Target lines', () => {
    const p = fullPlan().replace(/^Repro:.*\n/m, '').replace(/^Target lines:.*\n/m, '')
    expect(planGaps(p, { bug: false, releaseLines: false })).toEqual([])
    expect(planGaps(p, bug)).toEqual(['Repro: live | test | mocked | not-reproduced — <what you did>', 'Target lines: this base only | also <lines> — <why>'])
  })
  test('a mocked or missing reproduction says why live is not possible; tests or comments in the PR say who asked', () => {
    expect(planGaps(fullPlan().replace(/^Repro:.*$/m, 'Repro: mocked'), bug)).toEqual(['Repro: why (mocked — <why live is not possible>)'])
    expect(planGaps(fullPlan().replace(/^Repro:.*$/m, 'Repro: maybe'), bug)).toEqual(['Repro: live | test | mocked | not-reproduced — <what you did>'])
    expect(planGaps(fullPlan().replace(/^PR extras:.*$/m, 'PR extras: tests'), bug)).toEqual(['PR extras: who asked (tests — <the human\'s or the ticket\'s ask>)'])
  })
  test('the design choice has all three parts, filled in; each criterion has its check', () => {
    expect(planGaps(fullPlan().replace(/^- Reuses:.*$/m, '- Reuses: <helper>'), bug)).toEqual(['Design choice: Reuses'])
    expect(planGaps(fullPlan().replace(' — check: verify\n\n## Unchanged', '\n\n## Unchanged'), bug)).toEqual(['AC1: check'])
  })
})

describe('planFacts: the lines a fix is for', () => {
  test('"this base only": none besides the base; "also …": each line named, without origin/', () => {
    expect(planFacts(fullPlan()).targets).toEqual([])
    expect(planFacts(fullPlan().replace(/^Target lines:.*$/m, 'Target lines: also develop, origin/release/3.20 — the bug is on both')).targets).toEqual(['develop', 'release/3.20'])
    expect(planFacts(fullPlan().replace(/^Target lines:.*\n/m, '')).targets).toBeUndefined()
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

describe('prSummary: the PR title\'s text from pr.md', () => {
  test('the first heading, without a conventional-commit prefix the agent may have put there', () => {
    expect(prSummary('# fix(product): show remaining reservation quantity\n\nbody', 'fallback')).toBe('show remaining reservation quantity')
    expect(prSummary('# feat!: new export\n', 'x')).toBe('new export')
    expect(prSummary('# Show the remaining quantity\n', 'x')).toBe('Show the remaining quantity')
  })
  test('no heading: the fallback (the ticket title)', () => {
    expect(prSummary('just text', 'Ticket title')).toBe('Ticket title')
  })
})
