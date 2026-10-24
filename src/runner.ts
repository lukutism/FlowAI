import type { Agent } from './agent/fake.ts'
import type { AgentEvent } from './agent/stream.ts'
import { Ingest } from './ingest.ts'
import type { EventStore } from './store.ts'
import { Turns } from './turns.ts'
import { canStartTurn, type UsageLimits, type Windows } from './usage.ts'

export type RunAgent = Agent & { close?: () => Promise<void> }

export interface RunnerOptions {
  store: EventStore
  maxParallel: number
  limits: UsageLimits
  /** the agent of a run (one process per run, kept between turns) */
  agentFor: (run: string) => RunAgent
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** sees every agent event as it arrives (live output) */
  tap?: (run: string, e: AgentEvent) => void
  /** the plan windows as last saved, and where to save new ones */
  windows?: Windows
  onWindows?: (w: Windows) => void
}

/** Runs agent turns for runs: waits for room in the plan windows, records what each turn reports. */
export class Runner {
  readonly ingest: Ingest
  private turns: Turns

  constructor(private o: RunnerOptions) {
    this.ingest = new Ingest(o.store, o.onWindows)
    if (o.windows) this.ingest.windows = o.windows
    this.turns = new Turns({
      maxParallel: o.maxParallel, limits: o.limits, windows: () => this.ingest.windows, now: o.now, sleep: o.sleep,
      onPause: (run, g) => o.store.append(run, 'engine', { type: 'run.paused', window: g.window, until: g.until }),
      onResume: run => o.store.append(run, 'engine', { type: 'run.resumed' }),
    })
  }

  async turn(run: string, prompt: string): Promise<{ ok: boolean; text: string }> {
    return this.turnWith(run, this.o.agentFor(run), prompt)
  }

  /** a turn with another agent for the run (the reviewer): its tokens count for the run, its session is not the run's */
  async turnWith(run: string, agent: RunAgent, prompt: string, o: { ownSession?: boolean } = {}): Promise<{ ok: boolean; text: string }> {
    const own = o.ownSession ?? agent === this.o.agentFor(run)
    // the plan's usage limit ends a turn early: it is sent again once the window resets (the scheduler waits for it)
    for (let attempt = 0; ; attempt++) {
      const r = await this.once(run, agent, prompt, own)
      if (r.ok || r.blocked) return { ok: r.ok, text: r.text }
      if (r.limited && attempt < 3) {
        if (canStartTurn(this.ingest.windows, (this.o.now ?? Date.now)(), this.o.limits).ok) {
          // the limit showed only in the text, not in the windows: assume the 5-hour window and wait an hour
          const until = (this.o.now ?? Date.now)() + 3600_000
          this.ingest.windows = { ...this.ingest.windows, fiveHour: { utilization: 1, resetsAt: until / 1000, status: 'rejected' } }
        }
        continue
      }
      this.o.store.append(run, 'engine', { type: 'run.blocked', reason: `the agent's turn failed: ${r.text.trim().split('\n')[0]?.slice(0, 200) || r.reason}` })
      return { ok: false, text: r.text }
    }
  }

  private async once(run: string, agent: RunAgent, prompt: string, own: boolean): Promise<{ ok: boolean; text: string; reason: string; limited: boolean; blocked: boolean }> {
    const release = await this.turns.acquire(run)
    let rejected = false
    try {
      for await (const e of agent.turn(prompt)) {
        this.o.tap?.(run, e)
        if (e.kind === 'session' && !e.subscription) {
          await agent.close?.()
          this.o.store.append(run, 'engine', { type: 'run.blocked', reason: 'the agent session is not on your Claude subscription (an API key is set); flow stopped it before it could be billed' })
          return { ok: false, text: '', reason: 'api key', limited: false, blocked: true }
        }
        if (e.kind === 'usage' && Object.values(e.windows).some(w => w && w.status !== 'allowed')) rejected = true
        if (e.kind !== 'session' || own) this.ingest.agent(run, e)
        if (e.kind === 'result') {
          const limited = !e.ok && (rejected || /usage limit|rate limit|limit will reset|limit reached/i.test(e.text))
          return { ok: e.ok, text: e.text, reason: e.reason, limited, blocked: false }
        }
      }
      throw new Error('the turn ended without a result')
    } catch (err) {
      this.o.store.append(run, 'engine', { type: 'run.blocked', reason: `agent stopped: ${(err as Error).message}` })
      return { ok: false, text: '', reason: 'error', limited: false, blocked: true }
    } finally { release() }
  }
}
