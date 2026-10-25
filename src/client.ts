import type { RunEvent, RunState } from './run.ts'
import { RECENT, type Change, type FileDiff, type Message, type RequestBody, type RunFile, type RunLog } from './server.ts'
import type { Entry } from './transcript.ts'
import type { Command, ProjectSummary, Query, Reply } from './service.ts'
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
  /** a page of the service for the browser (a run's device), with the token */
  pageUrl(path: string): string { const u = new URL(this.ws.url); return `http://${u.host}${path}?token=${u.searchParams.get('token') ?? ''}` }
  private listeners = new Set<(m: Message) => void>()
  private pending = new Map<number, Pending>()
  private nextId = 1

  private constructor(private ws: WebSocket, private again?: () => Promise<{ url: string; token: string } | null>) {}

  /** again: where the service is now, asked when the connection drops (a restart moves it to another port) */
  static connect(url: string, token: string, again?: () => Promise<{ url: string; token: string } | null>): Promise<FlowClient> {
    return new Promise((ok, fail) => {
      let c: FlowClient | undefined
      FlowClient.open(url, token, m => c?.take(m), () => c?.dropped()).then(ws => { c = new FlowClient(ws, again); ok(c) }, fail)
    })
  }

  /** a socket to the service, once its snapshot came */
  private static open(url: string, token: string, take: (m: Message) => void, closed: () => void): Promise<WebSocket> {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`)
      let ready = false, first: Message | undefined
      ws.onmessage = ev => {
        const m = JSON.parse(String(ev.data)) as Message
        if (m.type === 'snapshot' && !ready) { ready = true; first = m; ok(ws); queueMicrotask(() => take(first!)); return }
        take(m)
      }
      ws.onerror = () => { if (!ready) fail(new Error('the flow service refused the connection (not running, or a wrong token)')) }
      ws.onclose = () => { if (!ready) fail(new Error('the flow service refused the connection (not running, or a wrong token)')); else closed() }
    })
  }

  /** the connection dropped: requests in flight are answered, then the service is looked for again until it answers */
  private dropped() {
    this.connected = false
    for (const p of this.pending.values()) p({ ok: false, error: 'the flow service restarted: try again' })
    this.pending.clear()
    this.take({ type: 'closed' })
    if (!this.again || this.closing) return
    void (async () => {
      while (!this.closing) {
        await Bun.sleep(1000)
        const t = await this.again!().catch(() => null)
        if (!t) continue
        try {
          this.ws = await FlowClient.open(t.url, t.token, m => this.take(m), () => this.dropped())
          this.connected = true
          return
        } catch {}
      }
    })()
  }
  private closing = false

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

  /** the run's agent session so far (new entries arrive as 'agent' messages) */
  async transcript(run: string): Promise<Entry[]> {
    const r = await this.request({ cmd: 'transcript', run })
    if (!r.ok || !('entries' in r)) throw new Error('error' in r ? r.error : 'no transcript')
    return r.entries
  }

  async log(run: string, name: RunLog, lines: number): Promise<string[]> {
    const r = await this.request({ cmd: 'log', run, name, lines })
    if (!r.ok || !('lines' in r)) throw new Error('error' in r ? r.error : 'no log')
    return r.lines
  }

  async diff(run: string): Promise<FileDiff[]> {
    const r = await this.request({ cmd: 'diff', run })
    if (!r.ok || !('diffs' in r)) throw new Error('error' in r ? r.error : 'no diff')
    return r.diffs
  }

  async changes(run: string): Promise<Change[]> {
    const r = await this.request({ cmd: 'changes', run })
    if (!r.ok || !('changes' in r)) throw new Error('error' in r ? r.error : 'no changes')
    return r.changes
  }

  /** a question of the new-run form; its answer, or the error */
  async query<T>(q: Query): Promise<T> {
    const r = await this.request({ cmd: 'query', query: q })
    if (!r.ok) throw new Error('error' in r ? r.error : 'no answer')
    if (!('data' in r)) throw new Error('no answer')
    return r.data as T
  }

  close() { this.closing = true; this.ws.close() }

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
    else if (m.type === 'event') { if (m.state) this.runs.set(m.state.id, m.state); else this.runs.delete(m.event.run); this.recent = [...this.recent, m.event].slice(-RECENT) }
    else if (m.type === 'windows') this.windows = m.windows
    else if (m.type === 'projects') this.projects = m.projects
    else if (m.type === 'reply') { this.pending.get(m.id)?.(m.reply); this.pending.delete(m.id) }
    for (const l of this.listeners) l(m)
  }
}
