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

describe('guard: the ways around it found in the security review are closed', () => {
  test.each([
    // quoting, paths and wrappers don't hide the program
    'git "push"',
    "'git' push origin x",
    '/usr/bin/git push',
    '\\git push',
    'command git push',
    'timeout 60 git push',
    'env -i PATH=/bin git commit -m x',
    'nice -n 5 git push',
    'echo x | xargs -n1 git push',
    'git --git-dir=.git --work-tree=. push',
    'git -C mobile -c core.pager=cat push',
    // command substitution runs, even inside double quotes
    'echo "$(git push)"',
    'echo `git commit -m x`',
    'x=$(git push 2>&1)',
    // shells and interpreters: their payload is checked too
    'bash -c "git push"',
    "sh -lc 'git commit -am wip'",
    'zsh -c "cd mobile && git push"',
    'eval "git push"',
    `node -e "require('child_process').execSync('git push')"`,
    `python3 -c "import os; os.system('git commit -m x')"`,
    // aliases and config that turn a harmless name into a publish
    'git -c alias.p=push p',
    'git config alias.p push',
    'git config --global alias.p push',
    'git config core.hooksPath /tmp/h',
    'git config --unset core.fsmonitor',
    'git config set core.fsmonitor x',
    // moving branches flow ships from
    'git branch -f develop HEAD',
    'git branch -m other',
    'git checkout -B develop',
    'git switch -C develop',
    'git symbolic-ref HEAD refs/heads/other',
    'git pull origin develop',
  ])('refused: %s', c => expect(bash(c)).toMatchObject({ deny: true }))
  test.each([
    'git config --get user.email',
    'git config user.email',
    'git config -l',
    'git config get user.name',
    'git -c core.pager=cat log -3',
    'bash -c "yarn lint && yarn tsc"',
    'node -e "console.log(process.version)"',
    'git checkout -b fix/x',
    'git symbolic-ref --short HEAD',
    'timeout 600 yarn jest src/a.test.ts',
    'git log --format="%H $(subject)"',
  ])('allowed: %s', c => expect(bash(c)).toBeNull())
  test('a long run of options is checked at once (no runaway matching)', () => {
    const t = performance.now()
    expect(bash('git ' + '-x '.repeat(20000) + '!')).toBeNull()
    expect(bash('curl ' + '-X '.repeat(20000) + 'https://dev.azure.com/x')).toBeDefined()
    expect(performance.now() - t).toBeLessThan(500)
  })
})

describe('guard: the code host\'s generic API calls write too', () => {
  test.each([
    'az rest --method post --uri https://dev.azure.com/o/p/_apis/wit/workitems/1',
    'az rest -m PATCH --uri https://dev.azure.com/o/_apis/x',
    'az rest --uri https://dev.azure.com/o/_apis/x --body "{}"',
    'az devops invoke --area wit --resource workitems --http-method PATCH',
    'gh workflow run deploy.yml',
    'gh run rerun 12',
    'gh secret set TOKEN',
    'gh api --method=DELETE repos/o/r/git/refs/heads/x',
    'curl -XPOST https://api.github.com/repos/o/r/issues',
    'curl -T body.json https://dev.azure.com/o/p/_apis/x',
  ])('refused: %s', c => expect(bash(c)).toMatchObject({ deny: true }))
  test.each([
    'az rest --uri https://dev.azure.com/o/p/_apis/wit/workitems/1',
    'az devops invoke --area wit --resource workitems --route-parameters id=1',
    'gh api -X GET repos/o/r/pulls',
    'gh run view 12 --log',
  ])('reading is allowed: %s', c => expect(bash(c)).toBeNull())
})

describe('guard: what the agent must not touch', () => {
  test('git\'s own files and Claude Code\'s settings, inside the worktree too', () => {
    expect(edit(`${wt}/.git/config`)).toMatchObject({ deny: true })
    expect(edit(`${wt}/.git`, 'Write')).toMatchObject({ deny: true })
    expect(edit(`${wt}/node_modules/x/.git/hooks/pre-commit`, 'Write')).toMatchObject({ deny: true })
    expect(edit(`${wt}/.claude/settings.local.json`, 'Write')).toMatchObject({ deny: true })
    expect(edit(`${wt}/.claude/settings.json`)).toMatchObject({ deny: true })
    expect(edit(`${wt}/.gitignore`)).toBeNull()
    expect(edit(`${wt}/docs/claude/settings.md`)).toBeNull()
  })
  test('a symlink in the worktree that points out of it is outside', () => {
    const { mkdtempSync, symlinkSync, realpathSync } = require('node:fs') as typeof import('node:fs')
    const root = realpathSync(mkdtempSync(require('node:path').join(require('node:os').homedir(), '.flow-guard-test-')))
    try {
      symlinkSync('/etc', `${root}/etc`)
      const g = (f: string) => guard({ tool_name: 'Write', tool_input: { file_path: f } }, { worktree: root })
      expect(g(`${root}/etc/hosts`)).toMatchObject({ deny: true })
      expect(g(`${root}/src/new.ts`)).toBeNull()
    } finally { require('node:fs').rmSync(root, { recursive: true, force: true }) }
  })
  test('shell commands that name flow\'s token are refused', () => {
    const home = require('node:os').homedir() as string
    const ctx = { worktree: wt, deny: [`${home}/.local/share/flow/token`] }
    const b = (command: string) => guard({ tool_name: 'Bash', tool_input: { command } }, ctx)
    expect(b(`head -c 64 ${home}/.local/share/flow/token`)).toMatchObject({ deny: true })
    expect(b('cat ~/.local/share/flow/token')).toMatchObject({ deny: true })
    expect(b('cat $HOME/.local/share/flow/token')).toMatchObject({ deny: true })
    expect(b(`ls ${home}/.local/share/flow/runs`)).toBeNull()
  })
})

describe('guard: bypasses found by the second review', () => {
  test.each([
    // shell keywords before the command
    'if git push; then :; fi',
    'for b in a; do git push origin $b; done',
    'while true; do git commit -am x; done',
    '! git push',
    'true && { git push; }',
    // redirections around it
    'git push>/dev/null',
    '>/dev/null git push',
    '2>&1 git push',
    '</dev/null git push',
    'git push 2>&1 | tee log',
    // ${…} is one word, and ${#…} is no comment
    'echo ${#a}; git push origin HEAD',
    'git -C ${D} push',
    // $'…' and $"…" quoting
    "git $'push'",
    "git $'\\x70ush'",
    'git $"push"',
    // wrappers and feeding a shell
    "env -S 'git push'",
    'find . -name x -exec git push \;',
    "echo 'git push' | sh",
    'echo git push | bash -s',
    // what else moves or publishes
    'git reset HEAD~1',
    'git reset --soft origin/develop',
    'git reset --mixed abc1234',
    'git commit-tree HEAD^{tree} -m x',
    'git send-pack origin x',
    'wget --post-data=x https://dev.azure.com/o/_apis/x',
    "curl -sd '{}' https://api.github.com/repos/o/r/issues",
  ])('refused: %s', c => expect(bash(c)).toMatchObject({ deny: true }))
  test.each([
    'git reset',
    'git reset -- src/a.ts',
    'git reset HEAD src/a.ts',
    'git reset -q',
    "gh api graphql -f query='query{viewer{login}}'",
    'gh api -X GET search/issues -f q=repo:o/r',
    'echo "${#list[@]} items"',
    'if [ -f a ]; then yarn lint; fi',
    'yarn tsc > /tmp/tsc.log 2>&1',
    'find . -name "*.ts" -exec grep -l foo {} \;',
  ])('allowed: %s', c => expect(bash(c)).toBeNull())
  test("Claude Code's settings in another case are the same file on macOS", () => {
    expect(edit(`${wt}/.CLAUDE/Settings.json`, 'Write')).toMatchObject({ deny: true })
    expect(edit(`${wt}/.Git/config`, 'Write')).toMatchObject({ deny: true })
  })
  test('a dangling symlink in the worktree pointing out of it is outside', () => {
    const { mkdtempSync, symlinkSync, realpathSync, rmSync } = require('node:fs') as typeof import('node:fs')
    const root = realpathSync(mkdtempSync(require('node:path').join(require('node:os').homedir(), '.flow-guard-test-')))
    try {
      symlinkSync(`${require('node:os').homedir()}/.flow-guard-nowhere-${process.pid}`, `${root}/link`)
      expect(guard({ tool_name: 'Write', tool_input: { file_path: `${root}/link` } }, { worktree: root })).toMatchObject({ deny: true })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('guard: what real agents ran that is fine (3,416 commands of hwt agents replayed)', () => {
  test.each([
    "cat >> .hwt/plan.md <<'EOF'\n## Notes\nflow commits it: git commit -m x, then git push\nEOF\necho done",
    'cat > notes.md <<-END\n\tgit push is not ours\n\tEND',
    'git worktree list',
    'git merge --abort && git status --short',
    'git cherry-pick --quit',
    'git rebase --abort',
    'az boards work-item update --help',
    'git commit --help',
  ])('allowed: %s', c => expect(bash(c)).toBeNull())
  test.each([
    'bash <<EOF\ngit push\nEOF',
    "python3 - <<'EOF'\nimport os\nos.system('git push')\nEOF",
    "cat > x.md <<'EOF'\ntext\nEOF\ngit push",
    'git cherry-pick --continue',
    'git worktree add ../x',
  ])('refused: %s', c => expect(bash(c)).toMatchObject({ deny: true }))
})

describe("guard: the run's device is flow's to boot and stop", () => {
  test('booting an emulator, or killing one, is refused with what to do instead', () => {
    for (const c of ['emulator -avd flow-x -port 5700', '~/Library/Android/sdk/emulator/emulator -avd x &', 'adb -s emulator-5554 emu kill', 'adb emu kill; adb devices', 'avdmanager create avd -n x -k y', 'sh -c "emulator -avd x"'])
      expect(bash(c)?.reason).toMatch(/device tool with action restart/)
  })
  test('reading devices and driving the run\'s own is fine', () => {
    for (const c of ['adb devices', 'adb -s emulator-5700 shell input tap 1 2', 'emulator -list-avds', 'adb -s emulator-5700 emu avd name', 'grep -rn emulator src'])
      expect(bash(c)).toBeNull()
  })
})
