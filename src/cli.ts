#!/usr/bin/env bun
/**
 * flow — Claude Code agents on tickets, on your own subscription.
 *
 *   flow start <project> <ticket> [--base <ref>] [--model <name>]   worktree, plan; continues until it needs you
 *   flow approve <run> [Q1=<answer> …]                             answer the plan's questions (defaults for the rest)
 *   flow message <run> "<text>"                                     to the run's agent; the run carries on afterwards
 *   flow ship <run>                                                 commit, push, draft PR (after verify)
 *   flow status [<run>]                                             runs and what they need; your plan windows
 *   flow log <run>                                                  the run's events
 *   flow try [--cwd <dir>] [--model <name>] "<message>" …          real turns in a folder, to check the connection
 *
 * Data: ~/.local/share/flow (FLOW_DATA); projects: ~/.config/flow/projects/<key>.json (FLOW_PROJECTS).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ClaudeAgent } from './agent/claude.ts'
import type { AgentEvent, Window } from './agent/stream.ts'
import { realAz } from './azure.ts'
import { loadProject } from './config.ts'
import { Pipeline } from './pipeline.ts'
import type { RunEvent, RunState } from './run.ts'
import { Runner } from './runner.ts'
import { writeRunSettings } from './settings.ts'
import { EventStore } from './store.ts'
import type { Windows } from './usage.ts'

const DATA = process.env.FLOW_DATA ?? join(homedir(), '.local', 'share', 'flow')
const PROJECTS = process.env.FLOW_PROJECTS ?? join(homedir(), '.config', 'flow', 'projects')

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const day = (ms: number) => new Date(ms).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`)
const win = (name: string, w: Window | undefined, fmt: (ms: number) => string) => (w ? `${name} ${Math.round(w.utilization * 100)}% (resets ${fmt(w.resetsAt * 1000)})` : `${name} –`)
const windowsLine = (w: Windows) => `plan: ${win('5h', w.fiveHour, hhmm)} · ${win('week', w.week, day)}`

function showAgent(e: AgentEvent) {
  if (e.kind === 'tool') console.log(`  ⋯ ${e.name} ${String(e.input.command ?? e.input.file_path ?? e.input.pattern ?? '').slice(0, 90)}`)
}
function showEvent(e: RunEvent) {
  const detail = e.type === 'tokens.used' ? k(e.tokens) : e.type === 'tool.denied' ? `${e.tool}: ${e.detail.slice(0, 80)}` : e.type === 'session.started' ? e.session
    : e.type === 'session.compacted' ? `${k(e.before)} → ${k(e.after)}` : e.type === 'run.paused' ? `${e.window} until ${hhmm(e.until)}`
    : e.type === 'run.blocked' || e.type === 'setup.failed' ? e.reason : e.type === 'plan.submitted' ? `${e.questions.length} question(s): ${e.summary.slice(0, 80)}`
    : e.type === 'verify.result' ? (e.ok ? 'no new findings' : `${e.newFindings.length} new: ${e.newFindings.slice(0, 3).join('; ')}`)
    : e.type === 'pr.opened' ? e.url : e.type === 'human.message' ? e.text.slice(0, 80) : ''
  console.log(`${hhmm(e.at)} ${e.run} ${e.actor.padEnd(6)} ${e.type}${detail ? ` · ${detail}` : ''}`)
}

/** what the run needs next, as the command to type */
function next(s: RunState): string {
  const n = s.needs
  if (!n) return s.status === 'done' ? 'done' : `${s.stage} · ${s.status}`
  if (n.kind === 'plan') {
    const qs = s.plan?.questions.map(q => `  ${q.id}${q.held ? ' (held)' : ''} ${q.text} — default: ${q.default}`).join('\n') ?? ''
    const when = n.held ? 'held for you: no deadline' : n.deadline ? `defaults apply at ${hhmm(n.deadline)} if unanswered` : ''
    return `plan needs you (${when})\n${qs}\n  → flow approve ${s.id} ${s.plan?.questions.map(q => `${q.id}=…`).join(' ')}`
  }
  if (n.kind === 'ship') return `verified → flow ship ${s.id}`
  if (n.kind === 'pr') return `draft PR #${s.pr?.number}: ${s.pr?.url}`
  return `${n.kind}: ${n.ask}\n  → flow message ${s.id} "…"`
}

const store = () => { mkdirSync(DATA, { recursive: true }); return new EventStore(join(DATA, 'flow.db')) }
const windows = (): Windows => { const f = join(DATA, 'usage.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {} }

function pipeline(s: EventStore, projectKey: string, model?: string) {
  const file = join(PROJECTS, `${projectKey}.json`)
  if (!existsSync(file)) throw new Error(`no project ${projectKey}: ${file} is missing`)
  s.subscribe(showEvent)
  return new Pipeline({ store: s, project: loadProject(file), az: realAz, dataDir: DATA, tap: (_, e) => showAgent(e),
    makeAgent: o => new ClaudeAgent({ ...o, model }) })
}

/** one command at a time per run: two would drive the same agent session */
function lock(run: string): () => void {
  const dir = join(DATA, 'runs', run), f = join(dir, 'lock')
  mkdirSync(dir, { recursive: true })
  if (existsSync(f)) {
    const pid = Number(readFileSync(f, 'utf8'))
    let alive = false
    try { process.kill(pid, 0); alive = true } catch {}
    if (alive) throw new Error(`flow is already working on ${run} (process ${pid})`)
  }
  writeFileSync(f, String(process.pid))
  return () => rmSync(f, { force: true })
}

function flags(args: string[], names: string[]) {
  const out: Record<string, string | undefined> = {}
  for (const n of names) { const i = args.indexOf(`--${n}`); if (i >= 0) out[n] = args.splice(i, 2)[1] }
  return out
}

async function withRun(run: string, model: string | undefined, act: (p: Pipeline) => Promise<unknown>) {
  const s = store()
  const state = s.state(run)
  if (!state) throw new Error(`no run ${run}: flow status`)
  const release = lock(run)
  const p = pipeline(s, state.project, model)
  try { await act(p) } finally { await p.close(); release() }
  console.log(`\n${next(s.state(run)!)}\n${windowsLine(p.runner.ingest.windows)}`)
}

async function main(argv: string[]) {
  const [cmd, ...args] = argv
  const f = flags(args, ['base', 'model', 'cwd'])
  switch (cmd) {
    case 'start': {
      const [project, ticket] = args
      if (!project || !ticket || !/^\d+$/.test(ticket)) throw new Error('flow start <project> <ticket number> [--base <ref>] [--model <name>]')
      const s = store()
      const run = `${project}-${ticket}`
      const release = lock(run)
      const p = pipeline(s, project, f.model)
      try { await p.start(Number(ticket), { base: f.base }) } finally { await p.close(); release() }
      console.log(`\n${next(s.state(run)!)}\n${windowsLine(p.runner.ingest.windows)}`)
      return
    }
    case 'approve': {
      const [run, ...pairs] = args
      if (!run) throw new Error('flow approve <run> [Q1=<answer> …]')
      const answers = Object.fromEntries(pairs.map(p => { const i = p.indexOf('='); if (i < 1) throw new Error(`"${p}": answers are Q1=<answer>`); return [p.slice(0, i).toUpperCase(), p.slice(i + 1)] }))
      return withRun(run, f.model, p => p.approve(run, answers))
    }
    case 'message': {
      const [run, ...words] = args
      if (!run || !words.length) throw new Error('flow message <run> "<text>"')
      return withRun(run, f.model, p => p.message(run, words.join(' ')))
    }
    case 'ship': {
      const [run] = args
      if (!run) throw new Error('flow ship <run>')
      return withRun(run, f.model, async p => { const pr = await p.ship(run); console.log(`draft PR #${pr.number}: ${pr.url}`) })
    }
    case 'status': {
      const s = store()
      const runs = args[0] ? [s.state(args[0])].filter((r): r is RunState => !!r) : s.runs()
      if (!runs.length) console.log(args[0] ? `no run ${args[0]}` : 'no runs yet: flow start <project> <ticket>')
      for (const r of runs) console.log(`${r.id.padEnd(16)} ${r.ticket} ${r.title.slice(0, 44).padEnd(44)} ${k(r.tokens).padStart(5)}  ${next(r).replace(/\n/g, '\n' + ' '.repeat(18))}`)
      console.log(windowsLine(windows()))
      return
    }
    case 'log': {
      const [run] = args
      if (!run) throw new Error('flow log <run>')
      for (const e of store().events(run)) showEvent(e)
      return
    }
    case 'try': return tryCmd(args, f.cwd, f.model)
    default:
      console.log(readFileSync(import.meta.path, 'utf8').split('\n').filter(l => /^ \* {3}flow /.test(l)).map(l => l.slice(3)).join('\n'))
      if (cmd) process.exitCode = 1
  }
}

async function tryCmd(prompts: string[], dir?: string, model?: string) {
  const cwd = dir ? resolve(dir) : mkdtempSync(join(tmpdir(), 'flow-try-'))
  if (!prompts.length) throw new Error('flow try [--cwd <dir>] [--model <name>] "<message>" …')
  const s = new EventStore(':memory:')
  s.subscribe(showEvent)
  const settings = writeRunSettings({ dir: mkdtempSync(join(tmpdir(), 'flow-run-')), worktree: cwd })
  const agent = new ClaudeAgent({ cwd, settings, model })
  const runner = new Runner({ store: s, maxParallel: 1, limits: { fiveHour: 0.9, week: 0.95 }, agentFor: () => agent, tap: (_, e) => showAgent(e) })
  console.log(`worktree ${cwd}`)
  s.append('try', 'human', { type: 'run.created', ticket: 'try', title: 'connection check', project: 'try', base: '-' })
  s.append('try', 'engine', { type: 'setup.done' })
  try {
    for (const p of prompts) {
      console.log(`\n→ ${p}`)
      const r = await runner.turn('try', p)
      console.log(`← ${r.ok ? '' : '(failed) '}${r.text.split('\n').slice(0, 6).join('\n  ')}`)
      if (!r.ok) break
    }
  } finally { await agent.close() }
  const st = s.state('try')!
  console.log(`\nrun: ${st.status} · tokens ${k(st.tokens)} · compactions ${st.compactions} · session ${st.session ?? '–'}\n${windowsLine(runner.ingest.windows)}`)
}

await main(process.argv.slice(2)).catch(e => { console.error(`flow: ${e.message}`); process.exit(1) })
