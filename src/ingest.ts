import type { AgentEvent, Tokens } from './agent/stream.ts'
import type { EventStore } from './store.ts'
import type { Windows } from './usage.ts'

/**
 * What an agent turn reports, turned into run events: its session, tokens per turn, compactions and the calls the
 * guard refused. Plan usage is machine-wide (all runs share the subscription), so it is kept here for the
 * scheduler rather than in any run's history.
 */
export class Ingest {
  windows: Windows = {}
  /** onWindows: the plan windows changed (flow saves them, so the next command knows them too) */
  constructor(private store: EventStore, private onWindows?: (w: Windows) => void) {}

  /** per run and session: the turn's model calls seen, and their tokens not yet written / written */
  private turns = new Map<string, { seen: Set<string>; pending: Tokens; written: Tokens }>()

  agent(run: string, e: AgentEvent) {
    switch (e.kind) {
      case 'step': {
        // kept as the turn goes (every 20 calls), so a turn cut off still counts; the result settles the rest
        const k = `${run}|${e.session}`, t = this.turns.get(k) ?? { seen: new Set<string>(), pending: zero(), written: zero() }
        this.turns.set(k, t)
        if (t.seen.has(e.id)) return
        t.seen.add(e.id)
        add(t.pending, e.tokens)
        if (t.seen.size % 20 === 0) { this.write(run, t.pending); add(t.written, t.pending); t.pending = zero() }
        return
      }
      case 'session':
        if (this.store.state(run)?.session !== e.session) this.store.append(run, 'agent', { type: 'session.started', session: e.session })
        return
      case 'denied': {
        const detail = typeof e.input.command === 'string' ? e.input.command : JSON.stringify(e.input).slice(0, 200)
        this.store.append(run, 'agent', { type: 'tool.denied', tool: e.tool, detail })
        return
      }
      case 'compaction':
        this.store.append(run, 'agent', { type: 'session.compacted', before: e.before, after: e.after })
        return
      case 'usage':
        this.windows = { ...this.windows, ...Object.fromEntries(Object.entries(e.windows).filter(([, w]) => w)) }
        this.onWindows?.(this.windows)
        return
      case 'result': {
        // the result's total, less what the turn's calls wrote already
        const k = `${run}|${e.session}`, done = this.turns.get(k)?.written ?? zero()
        this.turns.delete(k)
        this.write(run, { input: Math.max(0, e.tokens.input - done.input), output: Math.max(0, e.tokens.output - done.output), cacheRead: Math.max(0, e.tokens.cacheRead - done.cacheRead), cacheWrite: Math.max(0, e.tokens.cacheWrite - done.cacheWrite) })
        return
      }
    }
  }

  /** the new work apart from cache reads: a long turn re-reads its whole context once per model call */
  private write(run: string, x: Tokens) {
    const t = x.input + x.output + x.cacheWrite, cached = x.cacheRead
    if (t > 0 || cached > 0) this.store.append(run, 'agent', { type: 'tokens.used', tokens: t, ...(cached ? { cached } : {}) })
  }
}

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const add = (a: Tokens, b: Tokens) => { a.input += b.input; a.output += b.output; a.cacheRead += b.cacheRead; a.cacheWrite += b.cacheWrite }
