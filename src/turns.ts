import { canStartTurn, type TurnGate, type UsageLimits, type Windows } from './usage.ts'

export interface TurnsOptions {
  maxParallel: number
  limits: UsageLimits
  /** the latest plan windows the CLI reported (Ingest.windows) */
  windows: () => Windows
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onPause?: (run: string, gate: Extract<TurnGate, { ok: false }>) => void
  onResume?: (run: string) => void
  /** machine-wide agent slots (the service's); without it, maxParallel counts this scheduler's turns only */
  slot?: (run: string) => Promise<() => void>
}

/**
 * Who may start an agent turn now: the plan windows must have room (else the run pauses until the reset and
 * resumes by itself) and fewer than maxParallel turns may be running. All runs share one subscription.
 */
export class Turns {
  private active = 0
  private waiters: (() => void)[] = []
  constructor(private o: TurnsOptions) {}

  async acquire(run: string): Promise<() => void> {
    const now = this.o.now ?? Date.now, sleep = this.o.sleep ?? Bun.sleep
    let paused = false
    for (;;) {
      const g = canStartTurn(this.o.windows(), now(), this.o.limits)
      if (g.ok) break
      if (!paused) { paused = true; this.o.onPause?.(run, g) }
      // re-check at least every minute: a new report from another run may show room earlier
      await sleep(Math.max(1000, Math.min(g.until - now(), 60_000)))
    }
    if (this.o.slot) {
      const release = await this.o.slot(run)
      if (paused) this.o.onResume?.(run)
      return release
    }
    while (this.active >= this.o.maxParallel) await new Promise<void>(r => this.waiters.push(r))
    this.active++
    if (paused) this.o.onResume?.(run)
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.waiters.shift()?.()
    }
  }
}
