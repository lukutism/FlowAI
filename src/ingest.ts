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
  constructor(private store: EventStore) {}

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
        return
      case 'result': {
        const t = e.tokens.input + e.tokens.output + e.tokens.cacheRead + e.tokens.cacheWrite
        if (t > 0) this.store.append(run, 'agent', { type: 'tokens.used', tokens: t })
        return
      }
    }
  }
}
