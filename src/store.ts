import { Database } from 'bun:sqlite'
import { apply, type Actor, type EventBody, type RunEvent, type RunState } from './run.ts'

/**
 * The append-only event log (SQLite). An event is stored only if the run's state machine accepts it, so the log
 * never holds an impossible history. Run states are kept in memory, folded from the log on open.
 */
export class EventStore {
  private db: Database
  private states = new Map<string, RunState>()
  private listeners = new Set<(e: RunEvent) => void>()

  constructor(file: string, private now: () => number = Date.now) {
    this.db = new Database(file, { create: true })
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, run TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL)`)
    this.db.run('CREATE INDEX IF NOT EXISTS events_run ON events (run, seq)')
    for (const e of this.all()) this.states.set(e.run, apply(this.states.get(e.run), e))
  }

  append(run: string, actor: Actor, body: EventBody): RunEvent {
    const at = this.now()
    const draft = { ...body, seq: 0, at, run, actor } as RunEvent
    const next = apply(this.states.get(run), draft) // throws before anything is written
    const r = this.db.query('INSERT INTO events (at, run, actor, type, body) VALUES (?, ?, ?, ?, ?) RETURNING seq').get(at, run, actor, body.type, JSON.stringify(body)) as { seq: number }
    const e = { ...draft, seq: r.seq }
    this.states.set(run, next)
    for (const l of this.listeners) l(e)
    return e
  }

  state(run: string): RunState | undefined { return this.states.get(run) }

  /** every run's current state, the most recently changed first */
  runs(): RunState[] { return [...this.states.values()].sort((a, b) => b.updatedAt - a.updatedAt) }

  events(run: string): RunEvent[] { return this.rows('SELECT * FROM events WHERE run = ? ORDER BY seq', run) }

  since(seq: number): RunEvent[] { return this.rows('SELECT * FROM events WHERE seq > ? ORDER BY seq', seq) }

  /** the last n events of all runs, oldest first */
  recent(n: number): RunEvent[] { return this.rows('SELECT * FROM (SELECT * FROM events ORDER BY seq DESC LIMIT ?) ORDER BY seq', n) }

  subscribe(fn: (e: RunEvent) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  close() { this.db.close() }

  private all(): RunEvent[] { return this.rows('SELECT * FROM events ORDER BY seq') }

  private rows(sql: string, ...args: (string | number)[]): RunEvent[] {
    return (this.db.query(sql).all(...args) as { seq: number; at: number; run: string; actor: Actor; body: string }[])
      .map(r => ({ ...JSON.parse(r.body), seq: r.seq, at: r.at, run: r.run, actor: r.actor }) as RunEvent)
  }
}
