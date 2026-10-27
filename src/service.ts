import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { discoverAgentTools, type AgentTools } from './agenttools.ts'
import { join } from 'node:path'
import type { AgentEvent } from './agent/stream.ts'
import type { Az } from './azure.ts'
import { parseProject, type Project } from './config.ts'
import { Pipeline } from './pipeline.ts'
import { DEFAULT_LIMITS, Resources, WAITS_FOR, type Limits, type Snapshot } from './resources.ts'
import type { RunAgent } from './runner.ts'
import type { EventStore } from './store.ts'
import { appendTranscript, type Entry } from './transcript.ts'
import type { Windows } from './usage.ts'

export type Command =
  /** note: added to the agent's brief; logins: test logins, kept in a file only you can read */
  | { cmd: 'start'; project: string; ticket: number | string; task?: string; base?: string; kind?: 'bug' | 'feature'; repos?: string[]; device?: 'android' | 'ios'; patch?: string; devServer?: boolean; model?: string; note?: string; logins?: string; vars?: Record<string, string>; headless?: boolean }
  | { cmd: 'approve'; run: string; answers?: Record<string, string> }
  | { cmd: 'message'; run: string; text: string }
  | { cmd: 'ship'; run: string }
  | { cmd: 'port'; run: string; to?: string }
  /** stop the run's device and free its slot (ship does it too) */
  | { cmd: 'release'; run: string }
  /** the agent's turn running now ended at once; the run stops for you (a message carries it on) */
  | { cmd: 'stop'; run: string }
  /** the run's device stopped and booted again (new settings, a stuck emulator) */
  | { cmd: 'restartDevice'; run: string; add?: 'android' | 'ios' }
  /** a repo the run lacks: its own worktree on the run's branch; the agent's next turn has it */
  | { cmd: 'addRepo'; run: string; repo: string; base?: string }
  /** the run's repos brought up to their bases (the agent's change kept, uncommitted) */
  | { cmd: 'sync'; run: string }
  /** finished (merged, or given up): off the attention list */
  | { cmd: 'done'; run: string }
  /** device, worktrees and local branch removed, the folder archived; work never shipped needs force */
  | { cmd: 'remove'; run: string; force?: boolean }
  /** a project's settings as edited: checked, then written to its file (the old one kept as .bak) and used at once */
  | { cmd: 'saveProject'; project: string; json: Record<string, unknown> }

/** what the screen shows of a project */
export interface ProjectSummary {
  key: string; name: string; tracker: 'azure' | 'jira'; forge: 'azure' | 'github'; repos: string[]; devices: ('android' | 'ios')[]; patches: string[]; deadlineMinutes: number
  /** the repos a run gets when it names none; the repos with a dev server */
  defaults?: string[]; devServers?: string[]
  /** for the form's suggestions: each repo's pattern on a ticket's platform and tags; patch apps by pattern */
  repoMatch?: Record<string, string>; patchApps?: Record<string, string>
  /** for the Projects tab */
  maxParallel?: number; usage?: { fiveHour: number; week: number }; review?: boolean
  /** the new run's Login step asks for a license too */
  license?: boolean
  /** the first repo's default base: a run on another line (a release fix) can be ported to it */
  defaultBase?: string
  /** a run's emulator and browser run without their windows unless it says otherwise */
  headless?: boolean
  /** the run environment's variables, for the new-run form */
  vars?: { name: string; label?: string; choices?: string[]; default?: string; from?: string; repos?: string[] }[]
  sandbox?: { enabled: boolean; writable: number; domains: number; strict: boolean }
}

/** what the new-run form asks before a run exists */
export type Query =
  | { q: 'lookup'; project: string; ticket: number | string }
  | { q: 'bases'; project: string }
  | { q: 'refs'; project: string; repo: string }
  | { q: 'patches'; project: string }
  | { q: 'checkPatch'; project: string; patch: string; base: string }
  | { q: 'projectFile'; project: string }
  /** the plugins, skills and MCP servers the project's agents get (its first repo's checkout, as you would there) */
  | { q: 'agentTools'; project: string }

/** note: what happened when it isn't what you asked for (a message queued) */
export type Reply = { ok: true; run: string; note?: string } | { ok: false; error: string }
export interface Notice { run: string; text: string }

export interface ServiceDeps {
  store: EventStore
  /** what a project's agents get, seen by starting a session there (a stand-in in tests) */
  discoverTools?: (cwd: string) => Promise<AgentTools>
  projects: Record<string, Project>
  az: Az
  dataDir: string
  makeAgent: (o: { cwd: string; settings: string; resume?: string; model?: string; env?: Record<string, string>; appendSystemPrompt?: string; mcpConfig?: string }) => RunAgent
  makeReviewer?: (o: { cwd: string; settings: string; model?: string; maxTurns?: number }) => RunAgent
  gitEnv?: Record<string, string | undefined>
  now?: () => number
  tap?: (run: string, e: AgentEvent) => void
  /** machine-wide slot limits (~/.config/flow/flow.json) */
  limits?: Limits
  /** where the projects' files are (~/.config/flow/projects): their settings are read from and saved to <key>.json */
  projectsDir?: string
}

/**
 * The background process (flow serve): runs every action off the caller's back, one at a time per run, and applies
 * plan deadlines. Screens and the CLI send it commands and watch the event log.
 */
/** how often a draft PR's state is asked of the code host */
const PR_CHECK_MS = 2 * 60_000

export class Service {
  private pipes = new Map<string, Pipeline>()
  private busy = new Map<string, Promise<void>>()
  private prChecked = new Map<string, number>()
  /** runs being started (not recorded yet while their ticket is read), by project */
  private starting = new Map<string, string>()
  private notices = new Set<(n: Notice) => void>()
  private windowsListeners = new Set<(w: Windows) => void>()
  private lastWindows: Windows = {}
  private agentListeners = new Set<(run: string, e: Entry) => void>()
  private projectListeners = new Set<(p: ProjectSummary[]) => void>()

  /** the machine-wide slots every run shares */
  readonly slots: Resources

  constructor(private d: ServiceDeps) {
    this.slots = new Resources(d.limits ?? DEFAULT_LIMITS, {
      onWait: (run, kind) => { if (d.store.state(run)) d.store.append(run, 'engine', { type: 'run.waiting', resource: WAITS_FOR[kind] }) },
      onGo: run => { if (d.store.state(run)) d.store.append(run, 'engine', { type: 'run.resumed' }) },
    })
    // the windows the last turn reported, saved by the pipeline: the screen shows them before any new turn
    const saved = join(d.dataDir, 'usage.json')
    if (existsSync(saved)) try { this.lastWindows = JSON.parse(readFileSync(saved, 'utf8')) } catch {}
  }

  /**
   * After a restart the steps that were in flight are gone: a setup is done again, a plan with no session yet starts
   * again, an agent is told to carry on (its session resumes), a ship stops for the human, saying so; devices still up
   * count against the device slots again.
   */
  async recover() {
    const carry: { id: string; project: string; stage: string; put: string[] }[] = [], redo: typeof carry = [], replan: typeof carry = []
    for (const s of this.d.store.runs()) {
      if (!['running', 'waiting', 'paused'].includes(s.status)) continue
      // a change verify had set aside comes back first, or is named
      const put = s.stage === 'verify' && this.d.projects[s.project] ? await this.pipeline(s.project).restoreStashes(s.id).catch(() => []) : []
      const r = { id: s.id, project: s.project, stage: s.stage, put }
      // a ship waits for you; a setup is done again from the start; a plan with no session yet gets its step again;
      // otherwise the agent's session resumes where it was: it is told to carry on (the run goes on, not blocked)
      if (s.stage === 'ship' || !this.d.projects[s.project]) this.stopped(s.id, `flow's service restarted during ${s.stage}${put.length ? ` (${put.join('; ')})` : ''}`)
      else if (s.stage === 'setup') redo.push(r)
      else if (s.stage === 'plan' && !s.session) replan.push(r)
      else carry.push(r)
    }
    for (const key of Object.keys(this.d.projects)) this.pipeline(key).adoptDevices()
    for (const s of redo) this.act(s.id, () => this.pipeline(s.project).redoSetup(s.id))
    for (const s of replan) this.act(s.id, () => this.pipeline(s.project).restartPlan(s.id))
    for (const s of carry) this.act(s.id, () => this.pipeline(s.project).message(s.id, `flow restarted (a new release of flow) while you were working on ${s.stage === 'plan' ? 'the plan' : 'this step'}: your session is resumed${s.put.length ? ` (${s.put.join('; ')})` : ''}. Carry on where you left off and end the turn the usual way.`, 'flow'))
  }

  /** a run whose step ended without a decision: blocked with the reason (a failed setup can't be carried on) */
  private stopped(run: string, why: string) {
    const s = this.d.store.state(run)
    if (!s || !['running', 'waiting', 'paused'].includes(s.status)) return
    try {
      if (s.stage === 'setup') this.d.store.append(run, 'engine', { type: 'setup.failed', reason: why })
      else this.d.store.append(run, 'engine', { type: 'run.blocked', reason: `${why}; message the agent to carry on` })
    } catch {}
  }

  /** the tools of a run's agent, and a call of one (from the run's flow MCP server) */
  tools(run: string) { const s = this.d.store.state(run); if (!s) throw new Error(`no run ${run}`); return this.pipeline(s.project).tools(run) }
  tool(run: string, name: string, args: Record<string, unknown>) { const s = this.d.store.state(run); if (!s) throw new Error(`no run ${run}`); return this.pipeline(s.project).callTool(run, name, args) }

  onNotice(fn: (n: Notice) => void) { this.notices.add(fn); return () => { this.notices.delete(fn) } }
  onWindows(fn: (w: Windows) => void) { this.windowsListeners.add(fn); return () => { this.windowsListeners.delete(fn) } }
  windows(): Windows { return this.lastWindows }
  onProjects(fn: (p: ProjectSummary[]) => void) { this.projectListeners.add(fn); return () => { this.projectListeners.delete(fn) } }
  private projectFile(key: string): string {
    if (!this.d.projectsDir || !this.d.projects[key] || !/^[a-z0-9-]+$/.test(key)) throw new Error(`no settings file for project ${key}`)
    return join(this.d.projectsDir, `${key}.json`)
  }
  /** a project's settings saved: checked first (a mistake is named, nothing written), then taken by new runs */
  private saveProject(key: string, json: Record<string, unknown>) {
    const file = this.projectFile(key)
    const parsed = parseProject(json, `${key}.json`)
    if (parsed.key !== key) throw new Error(`${key}.json: key: a project's key can't change (it names its runs); add a new project instead`)
    if (existsSync(file)) copyFileSync(file, `${file}.bak`)
    writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
    this.d.projects[key] = parsed
    this.pipes.get(key)?.reconfigure(parsed)
    const ps = this.projects()
    for (const l of this.projectListeners) l(ps)
  }

  /** each entry of an agent session as it happens (also kept in the run's transcript) */
  onAgent(fn: (run: string, e: Entry) => void) { this.agentListeners.add(fn); return () => { this.agentListeners.delete(fn) } }
  private record(run: string, e: Entry) {
    let kept = e
    try { kept = appendTranscript(this.d.dataDir, run, e) } catch {}
    for (const l of this.agentListeners) l(run, kept)
  }
  resources(): Snapshot { return this.slots.snapshot() }
  projects(): ProjectSummary[] {
    return Object.values(this.d.projects).map(p => ({ key: p.key, name: p.name, tracker: p.tracker.kind, forge: p.forge.kind, repos: p.repos.map(r => r.key),
      devices: (['android', 'ios'] as const).filter(x => p.devices?.[x]), patches: p.repos.filter(r => r.patches).map(r => r.key), deadlineMinutes: p.plan.deadlineMinutes,
      defaults: (p.repos.some(r => r.default) ? p.repos.filter(r => r.default) : p.repos.slice(0, 1)).map(r => r.key), devServers: p.repos.filter(r => r.devServer).map(r => r.key),
      repoMatch: Object.fromEntries(p.repos.filter(r => r.match).map(r => [r.key, r.match!])), patchApps: p.patchApps,
      maxParallel: p.agent.maxParallel, usage: p.usage, review: p.review.enabled, license: p.login.license, defaultBase: (p.repos.find(r => r.default) ?? p.repos[0])?.defaultBase, vars: p.vars.map(({ detect: _, ...v }) => v), headless: p.devices?.headless ?? true,
      sandbox: p.sandbox ? (sb => ({ enabled: !!sb.enabled, writable: sb.filesystem?.allowWrite?.length ?? 0, domains: sb.network?.allowedDomains?.length ?? 0, strict: !!sb.network?.strictAllowlist }))(p.sandbox as { enabled?: boolean; filesystem?: { allowWrite?: string[] }; network?: { allowedDomains?: string[]; strictAllowlist?: boolean } }) : undefined }))
  }

  /** the new-run form's questions: a ticket, each repo's bases, the customer patches, whether one fits a base */
  async query(q: Query): Promise<unknown> {
    const p = this.pipeline(q.project)
    if (q.q === 'lookup') return p.lookup(q.ticket)
    if (q.q === 'bases') return Object.fromEntries(this.d.projects[q.project]!.repos.map(r => [r.key, p.bases(r.key)]))
    if (q.q === 'patches') return p.patchChoices()
    if (q.q === 'refs') return p.refs(q.repo)
    if (q.q === 'projectFile') { const path = this.projectFile(q.project); return { path, json: JSON.parse(readFileSync(path, 'utf8')) } }
    if (q.q === 'agentTools') {
      // a session is started to see them (seconds, while MCP servers connect): kept for a while
      const had = this.toolsSeen.get(q.project), now = (this.d.now ?? Date.now)()
      if (had && now - had.at < 10 * 60_000) return had.tools
      const tools = await (this.d.discoverTools ?? discoverAgentTools)(this.d.projects[q.project]!.repos[0]!.path)
      this.toolsSeen.set(q.project, { at: now, tools })
      return tools
    }
    return p.checkPatch(q.patch, q.base)
  }
  onResources(fn: (s: Snapshot) => void) { return this.slots.onChange(fn) }

  private pipeline(project: string): Pipeline {
    let p = this.pipes.get(project)
    if (!p) {
      const cfg = this.d.projects[project]
      if (!cfg) throw new Error(`no project ${project}`)
      p = new Pipeline({ store: this.d.store, project: cfg, az: this.d.az, dataDir: this.d.dataDir, makeAgent: this.d.makeAgent, makeReviewer: this.d.makeReviewer, resources: this.slots, gitEnv: this.d.gitEnv, now: this.d.now,
        tap: (run, e, own, who) => { this.d.tap?.(run, e); if (e.kind !== 'usage' && e.kind !== 'step') this.record(run, { ...e, at: (this.d.now ?? Date.now)(), own, ...(who ? { who } : {}) }) },
        onPrompt: (run, text, own, from, who) => this.record(run, { kind: 'prompt', from, text, at: (this.d.now ?? Date.now)(), own, ...(who ? { who } : {}) }),
        onWindows: w => { this.lastWindows = w; for (const l of this.windowsListeners) l(w) } })
      if (!Object.keys(this.lastWindows).length) this.lastWindows = p.runner.ingest.windows
      this.pipes.set(project, p)
    }
    return p
  }

  /** accept or refuse at once; the work itself runs in the background */
  dispatch(c: Command): Reply {
    try {
      if (c.cmd === 'saveProject') { this.saveProject(c.project, c.json); return { ok: true, run: '' } }
      if (c.cmd === 'start') {
        const p = this.pipeline(c.project)
        const run = c.task?.trim() && !String(c.ticket).trim() ? p.taskRunId(c.task) : p.runId(c.ticket)
        if (this.d.store.state(run)) throw new Error(`run ${run} exists already`)
        if (c.device && !this.d.projects[c.project]!.devices?.[c.device]) throw new Error(`project ${c.project} has no devices configured for ${c.device} (devices.${c.device} in its config)`)
        this.starting.set(run, c.project)
        this.act(run, async () => { await p.start(c.ticket, { base: c.base, kind: c.kind, repos: c.repos, device: c.device, patch: c.patch, devServer: c.devServer, model: c.model, task: c.task, note: c.note, logins: c.logins, ...(c.vars ? { vars: c.vars } : {}), ...(c.headless !== undefined ? { headless: c.headless } : {}) }) })
        return { ok: true, run }
      }
      if (c.cmd === 'stop') {
        const st = this.d.store.state(c.run)
        if (!st || !this.busy.has(c.run)) throw new Error(`${c.run} has no turn running`)
        void this.pipeline(st.project).stopTurn(c.run)
        return { ok: true, run: c.run }
      }
      // a message while the agent works waits for its next turn (or for the step to end), as in Claude Code
      const owner = this.d.store.state(c.run)?.project ?? this.starting.get(c.run)
      if (c.cmd === 'message' && this.busy.has(c.run) && owner) {
        this.pipeline(owner).queueMessage(c.run, c.text)
        return { ok: true, run: c.run, note: `queued for ${c.run}: the agent gets it with its next turn` }
      }
      // a run busy for a long while (a turn waiting hours for the usage window) is removed now, not refused: its agent
      // stopped first; the step that waited finds the run gone
      if (c.cmd === 'remove' && this.busy.has(c.run) && this.d.store.state(c.run)) {
        const p = this.pipeline(this.d.store.state(c.run)!.project)
        void (async () => { await p.closeAgent(c.run); await p.remove(c.run, { force: c.force }) })()
          .catch(e => { for (const l of this.notices) l({ run: c.run, text: (e as Error).message }) })
        return { ok: true, run: c.run }
      }
      // a run just started may not be recorded yet (its ticket is still being read): it is busy, not missing
      if (this.busy.has(c.run)) throw new Error(`${c.run} is busy: wait for its current step to end`)
      const s = this.d.store.state(c.run)
      if (!s) throw new Error(`no run ${c.run}`)
      const p = this.pipeline(s.project)
      if (c.cmd === 'port') {
        if (!s.pr) throw new Error(`${c.run} is not shipped yet: port a run that has its draft PR`)
        const to = c.to ?? p.defaultLine(c.run), run = `${c.run}-${to.split('/').pop()}`
        if (s.base.replace(/^origin\//, '') === to) throw new Error(`${c.run} is on ${to} already: port the release run instead`)
        if (this.d.store.state(run)) throw new Error(`run ${run} exists already`)
        this.act(run, async () => { await p.port(c.run, to) })
        return { ok: true, run }
      }
      if (c.cmd === 'done') {
        p.done(c.run)
        // done is done: the run goes as after a merge, unless it still has work to ship or a port to make (then its
        // device stops, and the notice says why it stays)
        this.act(c.run, async () => {
          const lines = p.unported(c.run)
          if (lines.length) { await p.releaseDevice(c.run); throw new Error(`kept: no port to ${lines.join(', ')} yet (flow port ${c.run} --to ${lines[0]}); remove it after`) }
          try { await p.remove(c.run) } catch (e) { await p.releaseDevice(c.run); throw new Error(`kept, its device stopped: ${(e as Error).message}`) }
        })
        return { ok: true, run: c.run }
      }
      const run = c.run
      const step = c.cmd === 'approve' ? () => p.approve(run, c.answers ?? {}) : c.cmd === 'message' ? () => p.message(run, c.text) : c.cmd === 'release' ? () => p.releaseDevice(run) : c.cmd === 'restartDevice' ? () => p.restartDevice(run, c.add)
        : c.cmd === 'addRepo' ? () => p.addRepo(run, c.repo, c.base).then(() => {}) : c.cmd === 'sync' ? () => p.sync(run).then(() => {})
        : c.cmd === 'remove' ? () => p.remove(run, { force: c.force }).then(() => {}) : c.cmd === 'ship' ? () => p.ship(run).then(() => {}) : null
      if (!step) throw new Error(`unknown command ${(c as { cmd: string }).cmd}`)
      this.act(run, step)
      return { ok: true, run: c.run }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  }

  /** plans past their deadline get their defaults (held ones never); draft PRs are looked at now and then */
  tick() {
    const now = (this.d.now ?? Date.now)()
    for (const s of this.d.store.runs()) {
      if (s.needs?.kind === 'pr' && !this.busy.has(s.id) && now - (this.prChecked.get(s.id) ?? 0) >= PR_CHECK_MS) {
        this.prChecked.set(s.id, now)
        // merged: done and removed (refused if something was left unshipped: then only done; kept too while a
        // release-line fix has no port to the default line, whose branch the port is made from); closed: done, kept
        this.act(s.id, async () => {
          const p = this.pipeline(s.project), state = await p.prsState(s.id)
          // still open: whether it is a draft or ready for review, recorded when that changes
          if (state === 'open' || state === 'draft') {
            const draft = state === 'draft', now = this.d.store.state(s.id)
            if (now && (now.prDraft ?? true) !== draft) this.d.store.append(s.id, 'engine', { type: 'pr.draft', draft })
            return
          }
          p.done(s.id, state === 'merged' ? 'its draft PR was merged' : 'its draft PR was closed')
          if (state !== 'merged') return
          const lines = p.unported(s.id)
          if (lines.length) throw new Error(`merged on ${s.base.replace(/^origin\//, '')} and kept: no port to ${lines.join(', ')} yet (${lines.map(l => `flow port ${s.id} --to ${l}`).join('; ')}); remove it after`)
          await p.remove(s.id)
        })
        continue
      }
    }
    // a run's emulator that stopped on its own is booted again, beside whatever its run is doing; one whose run is
    // paused for a long while is stopped (the slot goes to another run) and booted again shortly before it goes on
    for (const s of this.d.store.runs()) {
      if (this.reviving.has(s.id) || s.status === 'done' || s.status === 'failed' || !this.d.projects[s.project]) continue
      const p = this.pipeline(s.project)
      this.reviving.add(s.id)
      void (async () => { if (s.device) { if (!(await p.reviveDevice(s.id))) await p.parkDevice(s.id) } else await p.unparkDevice(s.id) })()
        .catch(e => { for (const l of this.notices) l({ run: s.id, text: `the device could not be booted again: ${(e as Error).message}` }) })
        .finally(() => this.reviving.delete(s.id))
    }
    for (const s of this.d.store.runs()) {
      const n = s.needs
      if (n?.kind !== 'plan' || n.held || !n.deadline || n.deadline > now || this.busy.has(s.id)) continue
      this.act(s.id, () => this.pipeline(s.project).decideByDeadline(s.id))
    }
  }

  private reviving = new Set<string>()
  private toolsSeen = new Map<string, { at: number; tools: AgentTools }>()

  async idle() { while (this.busy.size) await Promise.all(this.busy.values()) }

  async close() { await this.idle(); await this.shutdown() }

  /** the agents stopped now, busy or not */
  async shutdown() { await Promise.all([...this.pipes.values()].map(p => p.close())) }

  private act(run: string, fn: () => Promise<void>) {
    if (this.busy.has(run)) throw new Error(`${run} is busy: wait for its current step to end`)
    const p = (async () => {
      try { await fn() } catch (e) {
        // a refusal (not ready to ship) leaves the run as it was; a step that broke off mid-way blocks it
        this.stopped(run, (e as Error).message)
        for (const l of this.notices) l({ run, text: (e as Error).message })
      }
    })()
      .finally(() => {
        this.busy.delete(run)
        // messages queued during the step that no turn took: sent now
        const st = this.d.store.state(run)
        const left = st ? this.pipeline(st.project).takeQueued(run) : []
        if (left.length) { this.act(run, () => this.pipeline(st!.project).message(run, left.join('\n\n'))); return }
        // a run that stopped for the human (or ended) gives its agent process back; the next turn resumes the session
        const s = this.d.store.state(run)
        if (s && s.status !== 'running' && s.status !== 'waiting' && s.status !== 'paused') void this.pipeline(s.project).closeAgent(run)
      })
    this.busy.set(run, p)
  }
}
