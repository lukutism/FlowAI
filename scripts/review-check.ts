/**
 * A real review of a small change with a planted bug, by a claude session in plan mode: checks that the reviewer
 * answers in the format flow reads.   bun scripts/review-check.ts [--model <name>]
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeAgent } from '../src/agent/claude.ts'
import { changeText, parseFindings, reviewPrompt } from '../src/review.ts'
import { writeRunSettings } from '../src/settings.ts'

const model = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : undefined
const wt = mkdtempSync(join(tmpdir(), 'flow-review-check-'))
const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: wt, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
writeFileSync(join(wt, 'remaining.ts'), 'export const remaining = (required: number, withdrawn: number) => required\n')
git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base')
// the change: should be required - withdrawn, clamped at 0; it subtracts one too many
writeFileSync(join(wt, 'remaining.ts'), 'export const remaining = (required: number, withdrawn: number) => Math.max(0, required - withdrawn - 1)\n')
const settings = writeRunSettings({ dir: mkdtempSync(join(tmpdir(), 'flow-rev-run-')), worktree: wt })
const reviewer = new ClaudeAgent({ cwd: wt, settings, model, permissionMode: 'plan' })
const prompt = reviewPrompt({ key: '#1', title: 'Show the remaining quantity', ticket: 'Show required minus withdrawn; never below 0. 8 required, 6 withdrawn shows 2.', plan: 'Return required - withdrawn, clamped at 0.', change: changeText(wt) })
let text = ''
for await (const e of reviewer.turn(prompt)) {
  if (e.kind === 'tool') console.log(`  ⋯ ${e.name}`)
  if (e.kind === 'denied') console.log(`  denied: ${e.tool}`)
  if (e.kind === 'result') { text = e.text; console.log(`result ok=${e.ok} reason=${e.reason}`) }
}
await reviewer.close()
console.log(`--- answer (tail)\n${text.slice(-700)}`)
try { console.log('--- parsed', JSON.stringify(parseFindings(text), null, 1)) } catch (e) { console.log(`--- unreadable: ${(e as Error).message}`) }
