import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from './agent/stream.ts'
import type { Az } from './azure.ts'
import type { Project } from './config.ts'
import { Pipeline } from './pipeline.ts'
import { DEFAULT_LIMITS, Resources, WAITS_FOR, type Limits, type Snapshot } from './resources.ts'
import type { RunAgent } from './runner.ts'
import type { EventStore } from './store.ts'
import { appendTranscript, type Entry } from './transcript.ts'
import type { Windows } from './usage.ts'

export type Command =
  | { cmd: 'start'; project: string; ticket: number | string; base?: string; kind?: 'bug' | 'feature'; repos?: string[]; device?: 'android' | 'ios'; patch?: string; devServer?: boolean; model?: string }
  | { cmd: 'approve'; run: string; answers?: Record<string, string> }
  | { cmd: 'message'; run: string; text: string }
  | { cmd: 'ship'; run: string }
  | { cmd: 'port'; run: string; to?: string }
  /** stop the run's device and free its slot (ship does it too) */
  | { cmd: 'release'; run: string }

/** what the screen shows of a project */
export interface ProjectSummary {
  key: string; name: string; tracker: 'azure' | 'jira'; forge: 'azure' | 'github'; repos: string[]; devices: ('android' | 'ios')[]; patches: string[]; deadlineMinutes: number
  /** the repos a run gets when it names none; the repos with a dev server */
  defaults?: string[]; devServers?: string[]
}

/** what the new-run form asks before a run exists */
export type Query =
  | { q: 'lookup'; project: string; ticket: number | string }
  | { q: 'bases'; project: string }
  | { q: 'patches'; project: string }
  | { q: 'checkPatch'; project: string; patch: string; base: string }

export type Reply = { ok: true; run: string } | { ok: false; error: string }
export interface Notice { run: string; text: string }

export interface ServiceDeps {
  store: EventStore
  projects: Record<string, Project>
  az: Az
  dataDir: string
  makeAgent: (o: { cwd: string; settings: string; resume?: string }) => RunAgent
  makeReviewer?: (o: { cwd: string; settings: string }) => RunAgent
  gitEnv?: Record<string, string | undefined>
  now?: () => number
  tap?: (run: string, e: AgentEvent) => void
  /** machine-wide slot limits (~/.config/flow/flow.json) */
  limits?: Limits
}

/**
 * The background process (flow serve): runs every action off the caller's back, one at a time per run, and applies
 * plan deadlines. Screens and the CLI send it commands and watch the event log.
 */
export class Service {
  private pipes = new Map<string, Pipeline>()
  private busy = new Map<string, Promise<void>>()
  private notices = new Set<(n: Notice) => void>()
  private windowsListeners = new Set<(w: Windows) => void>()
  private lastWindows: Windows = {}
  private agentListeners = new Set<(run: string, e: Entry) => void>()

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

  onNotice(fn: (n: Notice) => void) { this.notices.add(fn); return () => { this.notices.delete(fn) } }
  onWindows(fn: (w: Windows) => void) { this.windowsListeners.add(fn); return () => { this.windowsListeners.delete(fn) } }
  windows(): Windows { return this.lastWindows }
  /** each entry of an agent session as it happens (also kept in the run's transcript) */
  onAgent(fn: (run: string, e: Entry) => void) { this.agentListeners.add(fn); return () => { this.agentListeners.delete(fn) } }
  private record(run: string, e: Entry) {
    try { appendTranscript(this.d.dataDir, run, e) } catch {}
    for (const l of this.agentListeners) l(run, e)
  }
  resources(): Snapshot { return this.slots.snapshot() }
  projects(): ProjectSummary[] {
    return Object.values(this.d.projects).map(p => ({ key: p.key, name: p.name, tracker: p.tracker.kind, forge: p.forge.kind, repos: p.repos.map(r => r.key),
      devices: (['android', 'ios'] as const).filter(x => p.devices?.[x]), patches: p.repos.filter(r => r.patches).map(r => r.key), deadlineMinutes: p.plan.deadlineMinutes,
      defaults: (p.repos.some(r => r.default) ? p.repos.filter(r => r.default) : p.repos.slice(0, 1)).map(r => r.key), devServers: p.repos.filter(r => r.devServer).map(r => r.key) }))
  }

  /** the new-run form's questions: a ticket, each repo's bases, the customer patches, whether one fits a base */
  async query(q: Query): Promise<unknown> {
    const p = this.pipeline(q.project)
    if (q.q === 'lookup') return p.lookup(q.ticket)
    if (q.q === 'bases') return Object.fromEntries(this.d.projects[q.project]!.repos.map(r => [r.key, p.bases(r.key)]))
    if (q.q === 'patches') return p.patchChoices()
    return p.checkPatch(q.patch, q.base)
  }
  onResources(fn: (s: Snapshot) => void) { return this.slots.onChange(fn) }

  private pipeline(project: string): Pipeline {
    let p = this.pipes.get(project)
    if (!p) {
      const cfg = this.d.projects[project]
      if (!cfg) throw new Error(`no project ${project}`)
      p = new Pipeline({ store: this.d.store, project: cfg, az: this.d.az, dataDir: this.d.dataDir, makeAgent: this.d.makeAgent, makeReviewer: this.d.makeReviewer, resources: this.slots, gitEnv: this.d.gitEnv, now: this.d.now,
        tap: (run, e, own) => { this.d.tap?.(run, e); if (e.kind !== 'usage') this.record(run, { ...e, at: (this.d.now ?? Date.now)(), own }) },
        onPrompt: (run, text, own, from) => this.record(run, { kind: 'prompt', from, text, at: (this.d.now ?? Date.now)(), own }),
        onWindows: w => { this.lastWindows = w; for (const l of this.windowsListeners) l(w) } })
      if (!Object.keys(this.lastWindows).length) this.lastWindows = p.runner.ingest.windows
      this.pipes.set(project, p)
    }
    return p
  }

  /** accept or refuse at once; the work itself runs in the background */
  dispatch(c: Command): Reply {
    try {
      if (c.cmd === 'start') {
        const p = this.pipeline(c.project)
        const run = p.runId(c.ticket)
        if (this.d.store.state(run)) throw new Error(`run ${run} exists already`)
        if (c.device && !this.d.projects[c.project]!.devices?.[c.device]) throw new Error(`project ${c.project} has no devices configured for ${c.device} (devices.${c.device} in its config)`)
        this.act(run, async () => { await p.start(c.ticket, { base: c.base, kind: c.kind, repos: c.repos, device: c.device, patch: c.patch, devServer: c.devServer, model: c.model }) })
        return { ok: true, run }
      }
      // a run just started may not be recorded yet (its ticket is still being read): it is busy, not missing
      if (this.busy.has(c.run)) throw new Error(`${c.run} is busy: wait for its current step to end`)
      const s = this.d.store.state(c.run)
      if (!s) throw new Error(`no run ${c.run}`)
      const p = this.pipeline(s.project)
      if (c.cmd === 'port') {
        if (!s.pr) throw new Error(`${c.run} is not shipped yet: port a run that has its draft PR`)
        const to = c.to ?? 'develop', run = `${c.run}-${to.split('/').pop()}`
        if (this.d.store.state(run)) throw new Error(`run ${run} exists already`)
        this.act(run, async () => { await p.port(c.run, to) })
        return { ok: true, run }
      }
      this.act(c.run, () => (c.cmd === 'approve' ? p.approve(c.run, c.answers ?? {}) : c.cmd === 'message' ? p.message(c.run, c.text) : c.cmd === 'release' ? p.releaseDevice(c.run) : p.ship(c.run).then(() => {})))
      return { ok: true, run: c.run }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  }

  /** plans past their deadline get their defaults (held ones never) */
  tick() {
    const now = (this.d.now ?? Date.now)()
    for (const s of this.d.store.runs()) {
      const n = s.needs
      if (n?.kind !== 'plan' || n.held || !n.deadline || n.deadline > now || this.busy.has(s.id)) continue
      this.act(s.id, () => this.pipeline(s.project).decideByDeadline(s.id))
    }
  }

  async idle() { while (this.busy.size) await Promise.all(this.busy.values()) }

  async close() { await this.idle(); for (const p of this.pipes.values()) await p.close() }

  private act(run: string, fn: () => Promise<void>) {
    if (this.busy.has(run)) throw new Error(`${run} is busy: wait for its current step to end`)
    const p = (async () => { try { await fn() } catch (e) { for (const l of this.notices) l({ run, text: (e as Error).message }) } })()
      .finally(() => { this.busy.delete(run) })
    this.busy.set(run, p)
  }
}
