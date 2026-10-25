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
  const file = writeRunSettings({ dir, worktree, allow: [join(dir, 'run')] })
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
  test('…and an edit in the run folder (plan.md)', async () => {
    expect(await runHook(hook.hooks[0].command, { tool_name: 'Write', tool_input: { file_path: join(dir, 'run', 'plan.md') } })).toBeNull()
  })
  test('without its worktree setting the guard fails closed', async () => {
    const out = await runHook(`${process.execPath} ${join(import.meta.dir, '..', 'src', 'guard.ts')}`, { tool_name: 'Edit', tool_input: { file_path: '/tmp/x' } })
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  })
})

describe('the OS sandbox, when the project asks for one', () => {
  test('the project\'s sandbox is passed on; the worktree and the run folder are writable first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-sb-'))
    const file = writeRunSettings({ dir, worktree: '/w/run/mobile', allow: ['/data/runs/x'], sandbox: { enabled: true, filesystem: { allowWrite: ['~/.cache'] }, network: { allowedDomains: ['registry.npmjs.org'] } } })
    const s = JSON.parse(readFileSync(file, 'utf8'))
    expect(s.sandbox).toEqual({ enabled: true, filesystem: { allowWrite: ['/w/run/mobile', '/data/runs/x', '~/.cache'] }, network: { allowedDomains: ['registry.npmjs.org'] } })
  })
  test('no sandbox in the project: none in the settings (the user\'s own setup decides)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-sb-'))
    expect(JSON.parse(readFileSync(writeRunSettings({ dir, worktree: '/w' }), 'utf8')).sandbox).toBeUndefined()
  })
})

describe('the run\'s settings: what the security review closed', () => {
  test('a guard that cannot run blocks the tool instead of letting it through (exit 2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-sb-'))
    const s = JSON.parse(readFileSync(writeRunSettings({ dir, worktree: '/w' }), 'utf8'))
    const broken = (s.hooks.PreToolUse[0].hooks[0].command as string).replace(/'[^']*guard\.ts'/, "'/nonexistent/guard.ts'")
    const p = Bun.spawn(['sh', '-c', broken], { stdin: new Blob(['{}']), stdout: 'pipe', stderr: 'pipe' })
    expect(await p.exited).toBe(2)
    expect(await new Response(p.stderr).text()).toMatch(/flow guard/)
  })
  test('flow\'s token: Read and Grep denied by rule, shell reads by the sandbox and the guard', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-sb-'))
    const s = JSON.parse(readFileSync(writeRunSettings({ dir, worktree: '/w', deny: ['/data/flow/token'], sandbox: { enabled: true } }), 'utf8'))
    expect(s.permissions.deny).toEqual(['Read(//data/flow/token)'])
    expect(s.sandbox.filesystem.denyRead).toEqual(['/data/flow/token'])
    expect(s.hooks.PreToolUse[0].hooks[0].command).toContain("FLOW_DENY='/data/flow/token'")
  })
  test('folders on PATH stay unwritable even inside a writable folder (a planted yarn or bun would run outside the sandbox)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-sb-')), home = require('node:os').homedir() as string
    const path = process.env.PATH
    process.env.PATH = `${home}/.bun/bin:/usr/bin:${home}/.local/bin`
    try {
      const s = JSON.parse(readFileSync(writeRunSettings({ dir, worktree: '/w', sandbox: { enabled: true, filesystem: { allowWrite: ['~/.bun', '~/.cache', `${home}/.local/bin`] } } }), 'utf8'))
      expect(s.sandbox.filesystem.denyWrite).toEqual([`${home}/.bun/bin`, `${home}/.local/bin`])
    } finally { process.env.PATH = path }
  })
})
