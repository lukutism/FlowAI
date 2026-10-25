import { describe, expect, test } from 'bun:test'
import { guard } from '../src/guard.ts'

// The agent works only inside its run's worktree and never publishes: shipping (commit, push, PR) and ticket
// writes are flow's steps, done after verify and review. Everything else is the user's own permission setup.
const wt = '/work/fso/.flow/worktrees/186278/mobile'
const bash = (command: string) => guard({ tool_name: 'Bash', tool_input: { command } }, { worktree: wt })
const edit = (file_path: string, tool = 'Edit') => guard({ tool_name: tool, tool_input: { file_path } }, { worktree: wt })

describe('guard: git steps that publish or rewrite history are flow\'s', () => {
  test.each([
    'git push origin fix/186278',
    'git commit -m "fix"',
    'git -C mobile push',
    'cd mobile && git push --force-with-lease',
    'yarn lint; git commit -am wip',
    'git merge origin/develop',
    'git rebase origin/develop',
    'git reset --hard HEAD~1',
    'git worktree add ../x',
    'git branch -D main',
    'git remote add upstream git@example:x/y.git',
    'git remote set-url origin git@example:x/y.git',
    'git tag v1.2.3',
    'git tag -a v1 -m x',
  ])('refused: %s', c => expect(bash(c)).toMatchObject({ deny: true }))
  test.each([
    'git status',
    'git diff origin/develop...HEAD',
    'git log --oneline -5',
    'git show HEAD:package.json',
    'git checkout -- src/a.ts',
    'git stash list',
    'yarn jest --findRelatedTests src/a.ts',
    'echo "git push is flow\'s job"',
    'git log --grep "fix; git push later"',
    // read-only forms of commands that can also write (a real agent's first command was refused for this)
    'git remote -v && git branch -vv && git status --short',
    'git remote show origin',
    'git tag',
    'git tag -l "v3.*"',
    'git branch -a',
  ])('allowed: %s', c => expect(bash(c)).toBeNull())
  test('the reason tells the agent what to do instead', () => {
    expect(bash('git push')!.reason).toMatch(/flow ships/i)
  })
})

describe('guard: no writes to the tracker or the code host', () => {
  test.each([
    'gh pr create --draft',
    'gh pr merge 12',
    'gh issue comment 5 -b hi',
    'gh api -X POST repos/o/r/issues',
    'az repos pr create --title x',
    'az boards work-item update --id 1 --state Done',
    'curl -X PATCH https://dev.azure.com/org/proj/_apis/wit/workitems/1',
    'curl -X POST https://example.atlassian.net/rest/api/3/issue/SGL-1/comment',
  ])('refused: %s', c => expect(bash(c)).toMatchObject({ deny: true }))
  test.each([
    'gh pr view 12 --json state',
    'gh api repos/o/r/pulls/12',
    'az boards work-item show --id 1',
    'curl https://dev.azure.com/org/proj/_apis/wit/workitems/1',
  ])('reading is allowed: %s', c => expect(bash(c)).toBeNull())
})

describe('guard: file edits stay inside the worktree', () => {
  test('inside: allowed, for every editing tool', () => {
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) expect(edit(`${wt}/src/a.ts`, t)).toBeNull()
  })
  test('outside, or escaping with ..: refused', () => {
    expect(edit('/work/fso/product-app/src/a.ts')).toMatchObject({ deny: true })
    expect(edit(`${wt}/../../other/src/a.ts`)).toMatchObject({ deny: true })
    expect(edit(`${wt}-evil/src/a.ts`)).toMatchObject({ deny: true })
  })
  test('the run folder (plan.md, pr.md) is allowed when flow names it', () => {
    const run = '/data/flow/runs/fso-186278'
    expect(guard({ tool_name: 'Write', tool_input: { file_path: `${run}/plan.md` } }, { worktree: wt, allow: [run] })).toBeNull()
    expect(guard({ tool_name: 'Write', tool_input: { file_path: `${run}-other/plan.md` } }, { worktree: wt, allow: [run] })).toMatchObject({ deny: true })
  })
  test('scratch space is allowed: the system temp folder', () => {
    expect(edit('/tmp/flow-notes.md', 'Write')).toBeNull()
  })
  test('other tools are not the guard\'s business', () => {
    expect(guard({ tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } }, { worktree: wt })).toBeNull()
    expect(guard({ tool_name: 'mcp__mobile-db__query', tool_input: {} }, { worktree: wt })).toBeNull()
  })
})
