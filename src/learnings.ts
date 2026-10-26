/**
 * What a run's agent learned (runs/<run>/learnings.md, one fact a line): `[repo:<key>]` lines go into that repo's
 * Claude memory, where every later agent of the repo reads them (hwt's agents too); `[flow]` lines into flow's own
 * backlog. Saved only once the run passed review and you shipped it, or you confirmed no change was needed, so a
 * ticket can't plant memory on its own.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export function splitLearnings(text: string): { repos: Record<string, string[]>; flow: string[] } {
  const out = { repos: {} as Record<string, string[]>, flow: [] as string[] }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:[-*]\s*)?\[(repo:([a-z0-9-]+)|flow)\]\s*(.+)$/.exec(line)
    if (!m) continue
    if (m[2]) (out.repos[m[2]] ??= []).push(m[3]!.trim())
    else out.flow.push(m[3]!.trim())
  }
  return out
}

/** a repo's Claude memory folder: its own setting (autoMemoryDirectory), else Claude Code's folder for its path */
export function memoryDir(repo: string): string {
  for (const f of ['settings.local.json', 'settings.json']) {
    try {
      const v = (JSON.parse(readFileSync(join(repo, '.claude', f), 'utf8')) as { autoMemoryDirectory?: string }).autoMemoryDirectory
      // a repo names its own memory, but flow writes there: only an absolute folder in your home is taken
      const dir = v ? resolve(v.replace(/^~(?=\/)/, homedir())) : ''
      if (dir && isAbsolute(v!.replace(/^~(?=\/)/, homedir())) && dir.startsWith(homedir() + '/')) return dir
    } catch {}
  }
  return join(homedir(), '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'), 'memory')
}

/** a run's lines into a file: earlier ones of the same run replaced (corrected wording leaves nothing behind) */
function replaceRun(file: string, head: string, run: string, lines: string[], line: (l: string) => string, mine: (l: string) => boolean) {
  const kept = (existsSync(file) ? readFileSync(file, 'utf8') : head).split('\n').filter(l => !mine(l))
  const fresh = [...new Set(lines)].map(line).filter(l => !kept.includes(l))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, kept.join('\n').replace(/\n*$/, '\n') + (fresh.length ? fresh.join('\n') + '\n' : ''))
}

export function saveLearnings(o: { run: string; text: string; memory: (repoKey: string) => string | undefined; backlog: string }): number {
  const { repos, flow } = splitLearnings(o.text)
  let n = 0
  for (const [key, lines] of Object.entries(repos)) {
    const dir = o.memory(key)
    if (!dir || !lines.length) continue
    const head = '---\nname: flow-learnings\ndescription: Non-obvious facts agents learned while fixing tickets in this repo (flow runs, one per line, the run named)\nmetadata:\n  type: project\n---\n\n'
    replaceRun(join(dir, 'flow-learnings.md'), head, o.run, lines, l => `- ${l} (${o.run})`, l => l.endsWith(` (${o.run})`))
    const index = join(dir, 'MEMORY.md'), idx = existsSync(index) ? readFileSync(index, 'utf8') : ''
    if (!idx.includes('flow-learnings.md')) writeFileSync(index, idx + (idx && !idx.endsWith('\n') ? '\n' : '') + '- [flow learnings](flow-learnings.md) — facts agents learned fixing tickets here\n')
    n += lines.length
  }
  if (flow.length) {
    const date = new Date().toISOString().slice(0, 10)
    replaceRun(o.backlog, "# flow backlog\n\nWhat agents found wrong or missing in flow (`[flow]` lines of a run's learnings.md). Fix in flow, then tick.\n\n", o.run, flow, l => `- [ ] ${date} ${o.run}: ${l}`, l => new RegExp(`^- \\[[ x]\\] \\d{4}-\\d{2}-\\d{2} ${o.run.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `).test(l))
    n += flow.length
  }
  return n
}
