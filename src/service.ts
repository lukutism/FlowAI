import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from './agent/stream.ts'
import type { Az } from './azure.ts'
import type { Project } from './config.ts'
import { Pipeline } from './pipeline.ts'
import type { RunAgent } from './runner.ts'
import type { EventStore } from './store.ts'
import type { Windows } from './usage.ts'

export type Command =
  | { cmd: 'start'; project: string; ticket: number; base?: string; kind?: 'bug' | 'feature' }
  | { cmd: 'approve'; run: string; answers?: Record<string, string> }
  | { cmd: 'message'; run: string; text: string }
  | { cmd: 'ship'; run: string }

export type Reply = { ok: true; run: string } | { ok: false; error: string }
export interface Notice { run: string; text: string }

export interface ServiceDeps {
  store: EventStore
  projects: Record<string, Project>
  az: Az
  dataDir: string
  makeAgent: (o: { cwd: string; settings: string; resume?: string }) => RunAgent
  gitEnv?: Record<string, string | undefined>
  now?: () => number
  tap?: (run: string, e: AgentEvent) => void
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

  constructor(private d: ServiceDeps) {
    // the windows the last turn reported, saved by the pipeline: the screen shows them before any new turn
    const saved = join(d.dataDir, 'usage.json')
    if (existsSync(saved)) try { this.lastWindows = JSON.parse(readFileSync(saved, 'utf8')) } catch {}
  }

  onNotice(fn: (n: Notice) => void) { this.notices.add(fn); return () => { this.notices.delete(fn) } }
  onWindows(fn: (w: Windows) => void) { this.windowsListeners.add(fn); return () => { this.windowsListeners.delete(fn) } }
  windows(): Windows { return this.lastWindows }

  private pipeline(project: string): Pipeline {
    let p = this.pipes.get(project)
    if (!p) {
      const cfg = this.d.projects[project]
      if (!cfg) throw new Error(`no project ${project}`)
      p = new Pipeline({ store: this.d.store, project: cfg, az: this.d.az, dataDir: this.d.dataDir, makeAgent: this.d.makeAgent, gitEnv: this.d.gitEnv, now: this.d.now, tap: this.d.tap,
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
        const run = `${c.project}-${c.ticket}`
        const p = this.pipeline(c.project)
        if (this.d.store.state(run)) throw new Error(`run ${run} exists already`)
        this.act(run, async () => { await p.start(c.ticket, { base: c.base, kind: c.kind }) })
        return { ok: true, run }
      }
      const s = this.d.store.state(c.run)
      if (!s) throw new Error(`no run ${c.run}`)
      const p = this.pipeline(s.project)
      this.act(c.run, () => (c.cmd === 'approve' ? p.approve(c.run, c.answers ?? {}) : c.cmd === 'message' ? p.message(c.run, c.text) : p.ship(c.run).then(() => {})))
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
