import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunEvent, RunState } from './run.ts'
import type { Command, Notice, ProjectSummary, Reply, Service } from './service.ts'
import type { EventStore } from './store.ts'
import type { Windows } from './usage.ts'
import type { Snapshot } from './resources.ts'

/** the files of a run the screen may read */
export const RUN_FILES = ['ticket.md', 'plan.md', 'pr.md', 'review.json'] as const
export type RunFile = (typeof RUN_FILES)[number]

export type RequestBody = Command | { cmd: 'events'; run: string } | { cmd: 'file'; run: string; name: RunFile }
export type Request = RequestBody & { id: number }

export type Message =
  | { type: 'snapshot'; runs: RunState[]; windows: Windows; resources?: Snapshot; recent?: RunEvent[]; projects?: ProjectSummary[] }
  /** not sent: the client's own word that the service went away */
  | { type: 'closed' }
  | { type: 'resources'; resources: Snapshot }
  | { type: 'event'; event: RunEvent; state: RunState }
  | { type: 'windows'; windows: Windows }
  | { type: 'notice'; notice: Notice }
  | { type: 'reply'; id: number; reply: Reply | { ok: true; events: RunEvent[] } | { ok: true; text: string } | { ok: false; error: string } }

type ServiceApi = Pick<Service, 'dispatch' | 'windows' | 'onNotice' | 'onWindows' | 'resources' | 'onResources' | 'projects'>

/** how many of the latest events the screen gets on connect (its Activity) */
export const RECENT = 300

/**
 * The service's socket: localhost only, and only with the token from a file only the user can read; a web page
 * could otherwise reach ws://localhost and send commands.
 */
export function serve(o: { service: ServiceApi; store: EventStore; dataDir: string; port: number; token: string }) {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: o.port,
    fetch(req, srv) {
      if (new URL(req.url).searchParams.get('token') !== o.token) return new Response('refused: wrong token', { status: 401 })
      if (srv.upgrade(req)) return undefined
      return new Response('flow service: connect with a WebSocket', { status: 400 })
    },
    websocket: {
      open(ws) {
        ws.subscribe('all')
        ws.send(JSON.stringify({ type: 'snapshot', runs: o.store.runs(), windows: o.service.windows(), resources: o.service.resources(), recent: o.store.recent(RECENT), projects: o.service.projects() } satisfies Message))
      },
      message(ws, raw) {
        let r: Request
        try { r = JSON.parse(String(raw)) } catch { return }
        const reply = (x: Extract<Message, { type: 'reply' }>['reply']) => ws.send(JSON.stringify({ type: 'reply', id: r.id, reply: x } satisfies Message))
        if (r.cmd === 'events') { reply({ ok: true, events: o.store.events(r.run) }); return }
        if (r.cmd === 'file') {
          if (!RUN_FILES.includes(r.name) || !/^[\w.-]+$/.test(r.run)) { reply({ ok: false, error: `${r.name} is not a run file` }); return }
          const f = join(o.dataDir, 'runs', r.run, r.name)
          reply({ ok: true, text: existsSync(f) ? readFileSync(f, 'utf8') : '' })
          return
        }
        const { id: _, ...command } = r
        reply(o.service.dispatch(command as Command))
      },
    },
  })
  const publish = (m: Message) => server.publish('all', JSON.stringify(m))
  const offs = [
    o.store.subscribe(e => publish({ type: 'event', event: e, state: o.store.state(e.run)! })),
    o.service.onNotice(n => publish({ type: 'notice', notice: n })),
    o.service.onWindows(w => publish({ type: 'windows', windows: w })),
    o.service.onResources(r => publish({ type: 'resources', resources: r })),
  ]
  return { port: server.port!, stop: () => { offs.forEach(f => f()); server.stop(true) } }
}
