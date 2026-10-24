import type { Agent } from './agent/fake.ts'
import type { AgentEvent } from './agent/stream.ts'
import { Ingest } from './ingest.ts'
import type { EventStore } from './store.ts'
import { Turns } from './turns.ts'
import type { UsageLimits, Windows } from './usage.ts'

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
    const release = await this.turns.acquire(run)
    const agent = this.o.agentFor(run)
    try {
      for await (const e of agent.turn(prompt)) {
        this.o.tap?.(run, e)
        if (e.kind === 'session' && !e.subscription) {
          await agent.close?.()
          this.o.store.append(run, 'engine', { type: 'run.blocked', reason: 'the agent session is not on your Claude subscription (an API key is set); flow stopped it before it could be billed' })
          return { ok: false, text: '' }
        }
        this.ingest.agent(run, e)
        if (e.kind === 'result') return { ok: e.ok, text: e.text }
      }
      throw new Error('the turn ended without a result')
    } catch (err) {
      this.o.store.append(run, 'engine', { type: 'run.blocked', reason: `agent stopped: ${(err as Error).message}` })
      return { ok: false, text: '' }
    } finally { release() }
  }
}
