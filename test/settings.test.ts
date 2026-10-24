import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeRunSettings } from '../src/settings.ts'

// The run's settings file adds flow's guard to the user's own setup (merged by the CLI, spike recording 07).
// These run the hook command exactly as the CLI would: through a shell, with the hook input on stdin.
const runHook = async (command: string, input: object) => {
  const p = Bun.spawn(['sh', '-c', command], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  await p.exited
  return out.trim() ? JSON.parse(out) : null
}

describe('the run\'s settings: flow\'s guard on every editing and shell tool', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-settings-')), worktree = join(dir, 'wt with space')
  const file = writeRunSettings({ dir, worktree })
  const s = JSON.parse(readFileSync(file, 'utf8'))
  const hook = s.hooks.PreToolUse[0]
  test('one PreToolUse hook, for Bash and the editing tools only; nothing else of the user\'s setup is touched', () => {
    expect(Object.keys(s)).toEqual(['hooks'])
    expect(hook.matcher).toBe('Bash|Edit|Write|MultiEdit|NotebookEdit')
  })
  test('the hook command, run as the CLI runs it, refuses a push with flow\'s reason', async () => {
    const out = await runHook(hook.hooks[0].command, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' } })
    expect(out).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/^flow: flow ships/) } })
  })
  test('…and lets an edit inside the worktree through (the path with a space is quoted right)', async () => {
    expect(await runHook(hook.hooks[0].command, { tool_name: 'Edit', tool_input: { file_path: join(worktree, 'src/a.ts') } })).toBeNull()
  })
  test('without its worktree setting the guard fails closed', async () => {
    const out = await runHook(`${process.execPath} ${join(import.meta.dir, '..', 'src', 'guard.ts')}`, { tool_name: 'Edit', tool_input: { file_path: '/tmp/x' } })
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  })
})
