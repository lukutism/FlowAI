/** a plan.md that has every part flow asks for (bug, release lines), with the given open questions */
export const fullPlan = (questions = 'none', summary = 'Guard the walk against missing assets.') => `# Plan

${summary}

Repro: test — a jest test on the walk fails on the base
Target lines: this base only — the bug is only here
PR extras: none

## Problem
The walk reads assets that are gone.

## Design choice
- Smallest option: skip missing assets in the walk
- Reuses: the existing isPresent helper
- Rejected: a new cache — more code than the bug needs

## Acceptance criteria
- AC1: WHEN an asset is missing THEN the list still shows — check: verify

## Unchanged behavior
- U1: WHEN all assets exist THEN the list is the same — check: verify

## Approach
src/b.ts

## Decisions log

## Open questions
${questions === 'none' ? '- none — the ticket says exactly what to change' : questions}
`
