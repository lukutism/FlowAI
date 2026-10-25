import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from './agent/stream.ts'

/**
 * A run's agent session as it happened, for the run detail's Agent pane: what flow and you sent, and what the agent
 * said and did. One JSON line per entry in runs/<run>/transcript.jsonl. own: the run's agent (false: the reviewer).
 */
export type Said = { kind: 'prompt'; from: 'flow' | 'you'; text: string }
export type Entry = (Exclude<AgentEvent, { kind: 'usage' }> | Said) & { at: number; own: boolean }

const file = (dataDir: string, run: string) => join(dataDir, 'runs', run, 'transcript.jsonl')

export function appendTranscript(dataDir: string, run: string, e: Entry) {
  mkdirSync(join(dataDir, 'runs', run), { recursive: true })
  appendFileSync(file(dataDir, run), JSON.stringify(e) + '\n')
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
  const lines = readFileSync(path, 'utf8').split('\n')
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  return lines.slice(-n)
}
