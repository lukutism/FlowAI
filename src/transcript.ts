import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from './agent/stream.ts'
import { loginValues, maskLogins } from './redact.ts'

/**
 * A run's agent session as it happened, for the run detail's Agent pane: what flow and you sent, and what the agent
 * said and did. One JSON line per entry in runs/<run>/transcript.jsonl. own: the run's agent (false: the reviewer).
 */
export type Said = { kind: 'prompt'; from: 'flow' | 'you'; text: string }
export type Entry = (Exclude<AgentEvent, { kind: 'usage' }> | Said) & { at: number; own: boolean }

const file = (dataDir: string, run: string) => join(dataDir, 'runs', run, 'transcript.jsonl')

/** a tool's long inputs cut (a whole file for Write): the pane shows a line of them, and every screen gets them */
const cut = (v: unknown): unknown => (typeof v === 'string' && v.length > 1000 ? `${v.slice(0, 1000)}… (${v.length} characters)` : v)

/** returns the entry as kept */
export function appendTranscript(dataDir: string, run: string, e: Entry): Entry {
  mkdirSync(join(dataDir, 'runs', run), { recursive: true })
  const short = e.kind === 'tool' ? { ...e, input: Object.fromEntries(Object.entries(e.input).map(([k, v]) => [k, cut(v)])) } : e
  // the run's test logins never reach the transcript or a screen (the agent types them on the device)
  const logins = join(dataDir, 'runs', run, 'logins.md')
  const values = existsSync(logins) ? loginValues(readFileSync(logins, 'utf8')) : []
  const kept = values.length ? JSON.parse(maskLogins(JSON.stringify(short), [...values, ...values.map(v => JSON.stringify(v).slice(1, -1))])) as Entry : short
  appendFileSync(file(dataDir, run), JSON.stringify(kept) + '\n')
  return kept
}

/** the last n entries, oldest first */
export function readTranscript(dataDir: string, run: string, n = 400): Entry[] {
  const f = file(dataDir, run)
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-n).flatMap(l => { try { return [JSON.parse(l) as Entry] } catch { return [] } })
}

/** the last n lines of a text file ('' lines at the end dropped) */
export function tail(path: string, n: number): string[] {
  if (!existsSync(path)) return []
  // only the end of the file (a log grows for days, and a pane asks every second)
  const size = statSync(path).size, want = Math.min(size, Math.max(64_000, n * 400))
  const buf = Buffer.alloc(want), fd = openSync(path, 'r')
  try { readSync(fd, buf, 0, want, size - want) } finally { closeSync(fd) }
  const lines = buf.toString('utf8').split('\n')
  if (want < size) lines.shift() // the first line is cut
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  return lines.slice(-n)
}
