#!/usr/bin/env bun
/**
 * flow — run Claude Code agents on tickets.
 *
 *   flow try [--cwd <dir>] [--model <name>] "<message>" ["<next message>" …]
 *       Real agent turns on your subscription in <dir> (default: a new empty folder), with flow's guard.
 *       Prints what the agent does, the run's events and your plan windows. For checking the connection.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ClaudeAgent } from './agent/claude.ts'
import type { AgentEvent, Window } from './agent/stream.ts'
import { Runner } from './runner.ts'
import { writeRunSettings } from './settings.ts'
import { EventStore } from './store.ts'
import type { RunEvent } from './run.ts'

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const day = (ms: number) => new Date(ms).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`)
const win = (name: string, w: Window | undefined, fmt: (ms: number) => string) => (w ? `${name} ${Math.round(w.utilization * 100)}% (resets ${fmt(w.resetsAt * 1000)})` : `${name} –`)

function showAgent(e: AgentEvent) {
  if (e.kind === 'tool') console.log(`  ⋯ ${e.name} ${String(e.input.command ?? e.input.file_path ?? e.input.pattern ?? '').slice(0, 90)}`)
  if (e.kind === 'text') console.log(`  » ${e.text.split('\n')[0]!.slice(0, 100)}`)
}
function showEvent(e: RunEvent) {
  const detail = e.type === 'tokens.used' ? k(e.tokens) : e.type === 'tool.denied' ? `${e.tool}: ${e.detail}` : e.type === 'session.started' ? e.session
    : e.type === 'session.compacted' ? `${k(e.before)} → ${k(e.after)}` : e.type === 'run.paused' ? `${e.window} until ${hhmm(e.until)}` : e.type === 'run.blocked' ? e.reason : ''
  console.log(`${hhmm(e.at)} ${e.actor.padEnd(6)} ${e.type}${detail ? ` · ${detail}` : ''}`)
}

async function tryCmd(args: string[]) {
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined }
  const dir = flag('--cwd'), model = flag('--model')
  const cwd = dir ? resolve(dir) : mkdtempSync(join(tmpdir(), 'flow-try-'))
  const prompts = args
  if (!prompts.length) throw new Error('flow try [--cwd <dir>] "<message>" …')
  const store = new EventStore(':memory:')
  store.subscribe(showEvent)
  const settings = writeRunSettings({ dir: mkdtempSync(join(tmpdir(), 'flow-run-')), worktree: cwd })
  const agent = new ClaudeAgent({ cwd, settings, model })
  const runner = new Runner({ store, maxParallel: 1, limits: { fiveHour: 0.9, week: 0.95 }, agentFor: () => agent, tap: (_, e) => showAgent(e) })
  console.log(`worktree ${cwd}`)
  store.append('try', 'human', { type: 'run.created', ticket: 'try', title: 'connection check', project: 'try', base: '-' })
  store.append('try', 'engine', { type: 'setup.done' })
  try {
    for (const p of prompts) {
      console.log(`\n→ ${p}`)
      const r = await runner.turn('try', p)
      console.log(`← ${r.ok ? '' : '(failed) '}${r.text.split('\n').slice(0, 6).join('\n  ')}`)
      if (!r.ok) break
    }
  } finally { await agent.close() }
  const s = store.state('try')!, w = runner.ingest.windows
  console.log(`\nrun: ${s.status} · tokens ${k(s.tokens)} · compactions ${s.compactions} · session ${s.session ?? '–'}`)
  console.log(`plan: ${win('5h', w.fiveHour, hhmm)} · ${win('week', w.week, day)}`)
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'try') await tryCmd(rest).catch(e => { console.error(`flow: ${e.message}`); process.exit(1) })
else { console.log('usage: flow try [--cwd <dir>] [--model <name>] "<message>" ["<next message>" …]'); process.exit(cmd ? 1 : 0) }
