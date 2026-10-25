import type { AgentEvent } from './agent/stream.ts'
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

  agent(run: string, e: AgentEvent) {
    switch (e.kind) {
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
        // the new work apart from cache reads: a long turn re-reads its whole context once per model call
        const t = e.tokens.input + e.tokens.output + e.tokens.cacheWrite, cached = e.tokens.cacheRead
        if (t > 0 || cached > 0) this.store.append(run, 'agent', { type: 'tokens.used', tokens: t, ...(cached ? { cached } : {}) })
        return
      }
    }
  }
}
