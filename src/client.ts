import type { RunEvent, RunState } from './run.ts'
import { RECENT, type Message, type RequestBody, type RunFile } from './server.ts'
import type { Command, ProjectSummary, Reply } from './service.ts'
import type { Windows } from './usage.ts'
import type { Snapshot } from './resources.ts'

type Pending = (m: Extract<Message, { type: 'reply' }>['reply']) => void

/** A connection to the background service: the runs as it last told them, live, and its commands. */
export class FlowClient {
  readonly runs = new Map<string, RunState>()
  windows: Windows = {}
  resources?: Snapshot
  /** the latest events of all runs, oldest first (the snapshot's, then each pushed one) */
  recent: RunEvent[] = []
  projects: ProjectSummary[] = []
  connected = true
  private listeners = new Set<(m: Message) => void>()
  private pending = new Map<number, Pending>()
  private nextId = 1

  private constructor(private ws: WebSocket) {}

  static connect(url: string, token: string): Promise<FlowClient> {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`)
      const c = new FlowClient(ws)
      let ready = false
      ws.onmessage = ev => {
        const m = JSON.parse(String(ev.data)) as Message
        c.take(m)
        if (m.type === 'snapshot' && !ready) { ready = true; ok(c) }
      }
      ws.onerror = () => { if (!ready) fail(new Error('the flow service refused the connection (not running, or a wrong token)')) }
      ws.onclose = () => {
        if (!ready) return fail(new Error('the flow service refused the connection (not running, or a wrong token)'))
        c.connected = false
        c.take({ type: 'closed' })
      }
    })
  }

  listen(fn: (m: Message) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }

  send(c: Command): Promise<Reply> { return this.request(c) as Promise<Reply> }

  async events(run: string): Promise<RunEvent[]> {
    const r = await this.request({ cmd: 'events', run })
    if (!r.ok || !('events' in r)) throw new Error('error' in r ? r.error : 'no events')
    return r.events
  }

  async file(run: string, name: RunFile): Promise<string> {
    const r = await this.request({ cmd: 'file', run, name })
    if (!r.ok || !('text' in r)) throw new Error('error' in r ? r.error : 'no file')
    return r.text
  }

  close() { this.ws.close() }

  private request(body: RequestBody): Promise<Extract<Message, { type: 'reply' }>['reply']> {
    const id = this.nextId++
    return new Promise(ok => {
      this.pending.set(id, ok)
      this.ws.send(JSON.stringify({ id, ...body }))
    })
  }

  private take(m: Message) {
    if (m.type === 'snapshot') { this.runs.clear(); for (const r of m.runs) this.runs.set(r.id, r); this.windows = m.windows; this.resources = m.resources; this.recent = m.recent ?? []; this.projects = m.projects ?? [] }
    else if (m.type === 'resources') this.resources = m.resources
    else if (m.type === 'event') { this.runs.set(m.state.id, m.state); this.recent = [...this.recent, m.event].slice(-RECENT) }
    else if (m.type === 'windows') this.windows = m.windows
    else if (m.type === 'reply') { this.pending.get(m.id)?.(m.reply); this.pending.delete(m.id) }
    for (const l of this.listeners) l(m)
  }
}
