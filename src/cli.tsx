#!/usr/bin/env bun
/**
 * flow — Claude Code agents on tickets, on your own subscription.
 *
 *   flow                                                            the screen (starts the background service if needed)
 *   flow serve                                                      the background service: runs, deadlines, the screen's data
 *   flow start <project> <ticket> [--repos a,b] [--base <ref>] [--kind bug|feature] [--device android|ios] [--dev-server] [--patch <customer>/<app>] [--model <name>] [--note "<for the agent>"] [--logins-file <file>] [--var NAME=value …] [--headed]   worktrees, plan; continues until it needs you
 *   flow approve <run> [Q1=<answer> …]                             answer the plan's questions (defaults for the rest)
 *   flow message <run> "<text>"                                     to the run's agent; the run carries on afterwards
 *   flow port <run> [--to <branch>]                               the shipped fix onto another line (default develop)
 *   flow ship <run>                                                 commit, push, draft PR (after verify); stops the run's device;
 *                                                                   a patch run: the write-back's dry run, then (again) the write-back
 *   flow release <run>                                              stop the run's device now and free its slot
 *   flow add <run> <repo> [--base <ref>]                            a repo the run lacks: its own worktree on the run's branch
 *   flow sync <run>                                                 the run's repos brought up to their bases (the change kept)
 *   flow doctor [<project>]                                         what a run would trip on: CLIs, logins, checkouts, devices, disk
 *   flow version                                                    the release running (its commit and date), or "source"
 *   flow code <run>                                                 the run's worktree in VS Code (FLOW_EDITOR to use another)
 *   flow device <run>                                               the run's device in the browser: see it, tap, swipe, type
 *   flow stop <run>                                                 end the agent's turn now; the run waits for a message
 *   flow done <run>                                                 the run is finished (merged, or given up): off the attention list
 *   flow rm <run> [--force]                                         remove it: device, worktrees, local branch; its folder archived
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
import { loadProject, loadSettings } from './config.ts'
import { Pipeline } from './pipeline.ts'
import type { RunEvent, RunState } from './run.ts'
import { Runner } from './runner.ts'
import { writeRunSettings } from './settings.ts'
import { EventStore } from './store.ts'
import { notice, show } from './notify.ts'
import { announce, connect, lock as lockService, running, startService, token, unlock as unlockService, withdraw } from './daemon.ts'
import type { FlowClient } from './client.ts'
import { serve } from './server.ts'
import { Service, type Command } from './service.ts'
import { readdirSync } from 'node:fs'
import type { Windows } from './usage.ts'

const DATA = process.env.FLOW_DATA ?? join(homedir(), '.local', 'share', 'flow')
const PROJECTS = process.env.FLOW_PROJECTS ?? join(homedir(), '.config', 'flow', 'projects')

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const day = (ms: number) => new Date(ms).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`)
// a window whose reset has passed: its last reading is stale until the next turn reports it
const win = (name: string, w: Window | undefined, fmt: (ms: number) => string) => (!w ? `${name} –` : w.resetsAt * 1000 <= Date.now() ? `${name} reset at ${fmt(w.resetsAt * 1000)}` : `${name} ${Math.round(w.utilization * 100)}% (resets ${fmt(w.resetsAt * 1000)})`)
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
  if (!n) return s.status === 'done' ? (s.patch ? `done: patch ${s.patch.customer}/${s.patch.app} written back` : 'done')
    : `${s.stage} · ${s.status}${s.status === 'waiting' && s.waitingFor ? ` for ${s.waitingFor}` : s.status === 'paused' && s.pausedUntil ? ` until ${hhmm(s.pausedUntil)}` : ''}`
  if (n.kind === 'plan') {
    const qs = s.plan?.questions.map(q => `  ${q.id}${q.held ? ' (held)' : ''} ${q.text}${q.options?.length ? ` — options: ${q.options.join(' | ')}` : ''} — default: ${q.default}`).join('\n') ?? ''
    // the deadline is applied by the background service (flow serve); without it flow waits for you
    const when = n.held ? 'held for you: no deadline' : n.deadline ? `defaults at ${hhmm(n.deadline)} if flow serve is running; otherwise it waits for you` : ''
    return `plan needs you (${when})\n${qs}\n  → flow approve ${s.id} ${s.plan?.questions.map(q => `${q.id}=…`).join(' ')}`
  }
  if (n.kind === 'ship') return s.patch ? `verified → flow ship ${s.id} (the write-back's dry run; nothing is written)` : `verified → flow ship ${s.id}`
  if (n.kind === 'patch') return `write-back checked: ${join(DATA, 'runs', s.id, 'patch-report.txt')}\n  → flow ship ${s.id} writes the patch back`
  if (n.kind === 'pr') return `${s.prDraft === false ? 'PR ready for review' : 'draft PR'} #${s.pr?.number}: ${s.pr?.url}`
  return `${n.kind}: ${n.ask}\n  → flow message ${s.id} "…"`
}

const store = () => { mkdirSync(DATA, { recursive: true }); return new EventStore(join(DATA, 'flow.db')) }
const windows = (): Windows => { const f = join(DATA, 'usage.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {} }

function pipeline(s: EventStore, projectKey: string, model?: string) {
  const file = join(PROJECTS, `${projectKey}.json`)
  if (!existsSync(file)) throw new Error(`no project ${projectKey}: ${file} is missing`)
  s.subscribe(showEvent)
  return new Pipeline({ store: s, project: loadProject(file), az: realAz, dataDir: DATA, tap: (_, e) => showAgent(e),
    makeAgent: o => new ClaudeAgent({ ...o, model: o.model ?? model }), makeReviewer: o => new ClaudeAgent({ ...o, model: o.model ?? model, permissionMode: 'plan' }) })
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

/** with the service running: send the command there and follow the run until it needs you */
async function viaService(c: FlowClient, cmd: Command): Promise<void> {
  let run = 'run' in cmd ? cmd.run : ''
  const settled = new Promise<void>(done => {
    c.listen(m => {
      if (m.type === 'event' && (m.event.run === run || (!run && m.event.type === 'run.created'))) {
        run ||= m.event.run
        showEvent(m.event)
        // a removal ends with the run gone, or with a notice saying why not (stopping its agent first can block it)
        if (cmd.cmd === 'remove') { if (m.event.type === 'run.removed') done() }
        else if ((!m.state || ['needs-you', 'blocked', 'failed', 'done', 'paused'].includes(m.state.status)) && m.event.type !== 'human.message') done()
      }
      if (m.type === 'notice' && m.notice.run === run) { console.log(`flow: ${m.notice.text}`); done() }
    })
  })
  const r = await c.send(cmd)
  if (!r.ok) throw new Error(r.error)
  run = r.run
  await settled
  const s = c.runs.get(run)
  if (s) console.log(`\n${next(s)}\n${windowsLine(c.windows)}`)
}

async function serveCmd() {
  if (!lockService(DATA)) throw new Error(`a flow service is running already for ${DATA} (pid ${running(DATA)?.pid ?? 'in serve.lock'})`)
  const projects = Object.fromEntries((existsSync(PROJECTS) ? readdirSync(PROJECTS) : []).filter(f => f.endsWith('.json')).map(f => { const p = loadProject(join(PROJECTS, f)); return [p.key, p] }))
  const s = store()
  s.subscribe(showEvent)
  const machine = loadSettings(join(PROJECTS, '..', 'flow.json'))
  if (machine.notify) {
    // a notification when a run starts needing you
    const last = new Map(s.runs().map(r => [r.id, r]))
    s.subscribe(e => { const after = s.state(e.run); if (!after) return; const n = notice(last.get(e.run), after); last.set(e.run, after); if (n) show(n) })
  }
  const svc = new Service({ store: s, projects, projectsDir: PROJECTS, limits: machine.limits, az: realAz, dataDir: DATA, makeAgent: o => new ClaudeAgent(o), makeReviewer: o => new ClaudeAgent({ ...o, permissionMode: 'plan' }), tap: (_, e) => showAgent(e) })
  svc.onNotice(n => console.log(`notice ${n.run}: ${n.text}`))
  const srv = serve({ service: svc, store: s, dataDir: DATA, port: 0, token: token(DATA) })
  announce(DATA, srv.port)
  console.log(`flow service on 127.0.0.1:${srv.port} (pid ${process.pid}); projects: ${Object.keys(projects).join(', ') || 'none'}`)
  await svc.recover()
  const tick = setInterval(() => svc.tick(), 30_000)
  svc.tick()
  // agents are stopped at once (their runs block and carry on after a message); waiting for every busy step
  // could take hours, and the next service would start beside this one
  const stop = async () => { clearInterval(tick); srv.stop(); await Promise.race([svc.shutdown(), Bun.sleep(5000)]); withdraw(DATA); unlockService(DATA); process.exit(0) }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  await new Promise(() => {})
}

async function uiCmd() {
  const client = (await connect(DATA, import.meta.path).catch(() => null)) ?? (await startService(DATA, import.meta.path))
  const { createCliRenderer } = await import('@opentui/core')
  const { createRoot } = await import('@opentui/react')
  const { App } = await import('./tui/app.tsx')
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  createRoot(renderer).render(<App api={client} onQuit={() => { renderer.destroy(); client.close(); process.exit(0) }} />)
}

async function main(argv: string[]) {
  const [cmd, ...args] = argv
  // --var NAME=value, as often as needed: the run's environment (the project's vars)
  const vars: Record<string, string> = {}
  for (let i = args.indexOf('--var'); i >= 0; i = args.indexOf('--var')) { const [k, ...v] = (args.splice(i, 2)[1] ?? '').split('='); if (k) vars[k] = v.join('=') }
  const f = flags(args, ['base', 'model', 'cwd', 'kind', 'to', 'repos', 'device', 'patch', 'note', 'logins-file'])
  const repos = f.repos ? f.repos.split(',').map(x => x.trim()).filter(Boolean) : undefined
  const service = ['start', 'approve', 'message', 'ship', 'port', 'release', 'done', 'rm', 'stop', 'add', 'sync'].includes(cmd ?? '') ? await connect(DATA).catch(() => null) : null
  switch (cmd) {
    case undefined: case 'ui': return uiCmd()
    case 'serve': return serveCmd()
    case 'start': {
      const [project, ticket] = args
      if (!project || !ticket) throw new Error('flow start <project> <ticket> [--repos a,b] [--base <ref>] [--kind bug|feature] [--device android|ios] [--patch <customer>/<app>] [--model <name>] [--note "…"] [--logins-file <file>] [--var NAME=value …] [--headed | --headless]')
      const tk = /^\d+$/.test(ticket) ? Number(ticket) : ticket
      if (f.kind && f.kind !== 'bug' && f.kind !== 'feature') throw new Error('--kind is bug or feature')
      if (f.device && f.device !== 'android' && f.device !== 'ios') throw new Error('--device is android or ios')
      const device = f.device as 'android' | 'ios' | undefined
      // test logins from a file, so they don't stay in the shell's history
      const logins = f['logins-file'] ? readFileSync(f['logins-file'], 'utf8') : undefined
      const extra = { ...(f.note ? { note: f.note } : {}), ...(logins ? { logins } : {}), ...(Object.keys(vars).length ? { vars } : {}), ...(args.includes('--headed') ? { headless: false } : args.includes('--headless') ? { headless: true } : {}) }
      if (service) return viaService(service, { cmd: 'start', project, ticket: tk, base: f.base, kind: f.kind as 'bug' | 'feature' | undefined, repos, device, patch: f.patch, devServer: args.includes('--dev-server'), ...(f.model ? { model: f.model } : {}), ...extra }).finally(() => service.close())
      const s = store()
      const p = pipeline(s, project, f.model)
      const run = p.runId(tk)
      const release = lock(run)
      try { await p.start(tk, { base: f.base, kind: f.kind as 'bug' | 'feature' | undefined, repos, device, patch: f.patch, devServer: args.includes('--dev-server'), ...extra }) } finally { await p.close(); release() }
      console.log(`\n${next(s.state(run)!)}\n${windowsLine(p.runner.ingest.windows)}`)
      return
    }
    case 'approve': {
      const [run, ...pairs] = args
      if (!run) throw new Error('flow approve <run> [Q1=<answer> …]')
      const answers = Object.fromEntries(pairs.map(p => { const i = p.indexOf('='); if (i < 1) throw new Error(`"${p}": answers are Q1=<answer>`); return [p.slice(0, i).toUpperCase(), p.slice(i + 1)] }))
      if (service) return viaService(service, { cmd: 'approve', run, answers }).finally(() => service.close())
      return withRun(run, f.model, p => p.approve(run, answers))
    }
    case 'message': {
      const [run, ...words] = args
      if (!run || !words.length) throw new Error('flow message <run> "<text>"')
      if (service) return viaService(service, { cmd: 'message', run, text: words.join(' ') }).finally(() => service.close())
      return withRun(run, f.model, p => p.message(run, words.join(' ')))
    }
    case 'ship': {
      const [run] = args
      if (!run) throw new Error('flow ship <run>')
      if (service) return viaService(service, { cmd: 'ship', run }).finally(() => service.close())
      return withRun(run, f.model, async p => {
        for (const pr of await p.ship(run)) console.log(`draft PR #${pr.number}: ${pr.url}`)
        const report = join(p.runDir(run), 'patch-report.txt')
        if (p.state(run)?.patch && existsSync(report)) console.log(readFileSync(report, 'utf8').trimEnd())
      })
    }
    case 'release': {
      const [run] = args
      if (!run) throw new Error('flow release <run>')
      if (service) return viaService(service, { cmd: 'release', run }).finally(() => service.close())
      return withRun(run, f.model, p => p.releaseDevice(run))
    }
    case 'add': {
      const [run, repo] = args
      if (!run || !repo) throw new Error('flow add <run> <repo> [--base <ref>]')
      const c = { cmd: 'addRepo' as const, run, repo, ...(f.base ? { base: f.base } : {}) }
      if (service) return viaService(service, c).finally(() => service.close())
      return withRun(run, f.model, async p => { console.log(await p.addRepo(run, repo, f.base)) })
    }
    case 'sync': {
      const [run] = args
      if (!run) throw new Error('flow sync <run>')
      if (service) return viaService(service, { cmd: 'sync', run }).finally(() => service.close())
      return withRun(run, f.model, async p => { for (const l of await p.sync(run)) console.log(l) })
    }
    case 'code': {
      const [run] = args
      if (!run) throw new Error('flow code <run>')
      const f = join(DATA, 'runs', run, 'run.json')
      if (!/^[\w.-]+$/.test(run) || !existsSync(f)) throw new Error(`no run ${run}: flow status`)
      const wt = (JSON.parse(readFileSync(f, 'utf8')) as { worktree: string }).worktree
      if (!existsSync(wt)) throw new Error(`${run}'s worktree is gone (${wt})`)
      Bun.spawn([process.env.FLOW_EDITOR ?? 'code', wt], { stdout: 'ignore', stderr: 'ignore' })
      console.log(wt)
      return
    }
    case 'device': {
      const [run] = args
      if (!run) throw new Error('flow device <run>')
      const c = (await connect(DATA).catch(() => null)) ?? (await startService(DATA, import.meta.path))
      try {
        if (!c.runs.get(run)?.device) throw new Error(`${run} has no device running`)
        const url = c.pageUrl(`/device/${run}`)
        console.log(url.replace(/token=.*/, 'token=…'))
        Bun.spawn([process.platform === 'darwin' ? 'open' : 'xdg-open', url])
      } finally { c.close() }
      return
    }
    case 'stop': {
      const [run] = args
      if (!run) throw new Error('flow stop <run>')
      if (!service) throw new Error('no turn is running: the flow service is not running')
      const r = await service.send({ cmd: 'stop', run }).finally(() => service.close())
      if (!r.ok) throw new Error(r.error)
      console.log(`${run}: the agent's turn is stopped; flow message ${run} "…" carries it on`)
      return
    }
    case 'done': {
      const [run] = args
      if (!run) throw new Error('flow done <run>')
      if (service) return viaService(service, { cmd: 'done', run }).finally(() => service.close())
      return withRun(run, f.model, async p => p.done(run))
    }
    case 'rm': {
      const [run] = args
      if (!run) throw new Error('flow rm <run> [--force]')
      const force = args.includes('--force')
      if (service) return viaService(service, { cmd: 'remove', run, force }).finally(() => service.close())
      return withRun(run, f.model, async p => { for (const w of (await p.remove(run, { force })).removed) console.log(`removed ${w}`) })
    }
    case 'port': {
      const [run] = args
      if (!run) throw new Error('flow port <run> [--to <branch>]')
      if (service) return viaService(service, { cmd: 'port', run, to: f.to }).finally(() => service.close())
      const s = store()
      const state = s.state(run)
      if (!state) throw new Error(`no run ${run}: flow status`)
      const p = pipeline(s, state.project, f.model)
      const port = `${run}-${(f.to ?? 'develop').split('/').pop()}`
      const release = lock(port)
      try { await p.port(run, f.to ?? 'develop') } finally { await p.close(); release() }
      console.log(`\n${next(s.state(port)!)}\n${windowsLine(p.runner.ingest.windows)}`)
      return
    }
    case 'version': { console.log(process.env.FLOW_RELEASE ?? `source ${new TextDecoder().decode(Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: import.meta.dir }).stdout).trim()}`); return }
    case 'doctor': {
      const { doctor, report } = await import('./doctor.ts')
      const all = (existsSync(PROJECTS) ? readdirSync(PROJECTS) : []).filter(f => f.endsWith('.json')).map(f => loadProject(join(PROJECTS, f)))
      const projects = args[0] ? all.filter(p => p.key === args[0]) : all
      if (args[0] && !projects.length) throw new Error(`no project ${args[0]} in ${PROJECTS}`)
      const checks = await doctor(projects, {
        run: async (argv, cwd) => {
          const p = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe', env: process.env })
          const timer = setTimeout(() => p.kill(), 20_000)
          const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
          clearTimeout(timer)
          return { code: await p.exited, out, err }
        },
        exists: existsSync,
        freeGB: path => {
          let at = path
          while (!existsSync(at) && at !== '/') at = join(at, '..')
          const r = Bun.spawnSync(['df', '-k', at])
          const kb = Number(new TextDecoder().decode(r.stdout).trim().split('\n').pop()?.split(/\s+/)[3])
          return Number.isFinite(kb) ? kb / 1024 / 1024 : Infinity
        },
        serviceUp: () => !!running(DATA),
      })
      console.log(report(checks))
      if (checks.some(c => !c.ok)) process.exitCode = 1
      return
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
      if (cmd === 'help' || cmd === '--help') process.exitCode = 0
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
