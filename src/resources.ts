/**
 * Machine-wide slots shared by every run of every project: agent turns, heavy builds (installs, verify), devices.
 * A run that finds them full waits, first come first served, and the waiting is recorded so the screen can say why.
 */
export type Kind = 'agents' | 'builds' | 'devices'
export type Limits = Record<Kind, number>
export const DEFAULT_LIMITS: Limits = { agents: 2, builds: 2, devices: 4 }
/** what a run waits for, in words */
export const WAITS_FOR: Record<Kind, string> = { agents: 'an agent slot', builds: 'a build slot', devices: 'a device' }

export interface Snapshot { limits: Limits; holders: Record<Kind, string[]>; waiting: { run: string; kind: Kind }[] }

export class Resources {
  private holders: Record<Kind, string[]> = { agents: [], builds: [], devices: [] }
  private queue: { run: string; kind: Kind; go: () => void }[] = []
  private listeners = new Set<(s: Snapshot) => void>()

  constructor(readonly limits: Limits = DEFAULT_LIMITS, private o: { onWait?: (run: string, kind: Kind) => void; onGo?: (run: string, kind: Kind) => void } = {}) {}

  onChange(fn: (s: Snapshot) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }

  snapshot(): Snapshot {
    return { limits: { ...this.limits }, holders: { agents: [...this.holders.agents], builds: [...this.holders.builds], devices: [...this.holders.devices] }, waiting: this.queue.map(q => ({ run: q.run, kind: q.kind })) }
  }

  /** a slot taken at once even past the limit (a device found still up after a restart is there either way) */
  hold(run: string, kind: Kind): () => void {
    this.holders[kind].push(run)
    this.changed()
    return this.releaser(run, kind)
  }

  /** a slot of this kind for the run; resolves to its release (safe to call twice) */
  async acquire(run: string, kind: Kind): Promise<() => void> {
    if (this.holders[kind].length >= this.limits[kind] || this.queue.some(q => q.kind === kind)) {
      // in the queue before the notice: a slot freed by whoever reacts to the notice must find this run waiting
      let go!: () => void
      const turn = new Promise<void>(r => { go = r })
      this.queue.push({ run, kind, go })
      this.changed()
      this.o.onWait?.(run, kind)
      await turn // the releasing run handed this one its slot (see below)
      this.o.onGo?.(run, kind)
    } else {
      this.holders[kind].push(run)
      this.changed()
    }
    return this.releaser(run, kind)
  }

  private releaser(run: string, kind: Kind): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const i = this.holders[kind].indexOf(run)
      if (i >= 0) this.holders[kind].splice(i, 1)
      // the slot goes straight to the next waiter: a run arriving in the same moment can't take it first
      const next = this.queue.findIndex(q => q.kind === kind)
      if (next >= 0) { const w = this.queue.splice(next, 1)[0]!; this.holders[kind].push(w.run); w.go() }
      this.changed()
    }
  }

  private changed() { const s = this.snapshot(); for (const l of this.listeners) l(s) }
}
