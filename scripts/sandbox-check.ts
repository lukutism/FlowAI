/**
 * Real check of a project's OS sandbox: an agent tries a shell write inside its worktree and one outside it.
 *   bun scripts/sandbox-check.ts <project.json> <worktree> [--model <name>]
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ClaudeAgent } from '../src/agent/claude.ts'
import { loadProject } from '../src/config.ts'
import { writeRunSettings } from '../src/settings.ts'

const [projectFile, dir] = process.argv.slice(2)
const model = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : undefined
if (!projectFile || !dir) throw new Error('bun scripts/sandbox-check.ts <project.json> <worktree>')
const wt = resolve(dir), outside = join(dirname(wt), 'outside-sh.txt'), inside = join(wt, 'inside-sh.txt')
rmSync(outside, { force: true }); rmSync(inside, { force: true })
const settings = writeRunSettings({ dir: mkdtempSync(join(tmpdir(), 'flow-sb-run-')), worktree: wt, sandbox: loadProject(projectFile).sandbox })
const agent = new ClaudeAgent({ cwd: wt, settings, model })
for await (const e of agent.turn(`Run these two Bash commands separately, exactly as written, and report each result in one line:\n1. echo hi > inside-sh.txt\n2. echo hi > ../outside-sh.txt`)) {
  if (e.kind === 'tool') console.log(`  ⋯ ${e.name} ${String(e.input.command ?? '')}`)
  if (e.kind === 'result') console.log(`← ${e.text.slice(0, 400)}`)
}
await agent.close()
console.log(`inside written: ${existsSync(inside)} · outside written: ${existsSync(outside)}`)
rmSync(inside, { force: true }); rmSync(outside, { force: true })
