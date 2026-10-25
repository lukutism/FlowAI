import { deviceSize, frame, parseInput, send, video } from './screen.ts'
import { screenPage } from './screen-page.ts'
import type { DeviceState } from './device.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunEvent, RunState } from './run.ts'
import type { Command, Notice, ProjectSummary, Query, Reply, Service } from './service.ts'
import type { EventStore } from './store.ts'
import type { Windows } from './usage.ts'
import type { Snapshot } from './resources.ts'
import { readTranscript, tail, type Entry } from './transcript.ts'

/** the files of a run the screen may read */
export const RUN_FILES = ['ticket.md', 'plan.md', 'pr.md', 'review.json', 'run.json'] as const
export type RunFile = (typeof RUN_FILES)[number]

/** a file a run changed, in one of its repos */
export interface Change { repo: string; file: string; added: number; removed: number; status: 'M' | 'A' | 'D' }

/** what a run changed in its worktrees so far, committed or not (from where its branch left the base), then new files */
export function changes(dataDir: string, run: string): Change[] {
  const f = join(dataDir, 'runs', run, 'run.json')
  if (!existsSync(f)) return []
  const meta = JSON.parse(readFileSync(f, 'utf8')) as { repos?: { key: string; worktree: string; base?: string }[]; repo?: string; worktree?: string; base?: string }
  const repos = meta.repos ?? (meta.worktree ? [{ key: meta.repo ?? 'repo', worktree: meta.worktree, base: meta.base }] : [])
  const git = (cwd: string, ...a: string[]) => new TextDecoder().decode(Bun.spawnSync(['git', ...a], { cwd }).stdout)
  return repos.flatMap(r => {
    if (!existsSync(r.worktree)) return []
    const from = (r.base && git(r.worktree, 'merge-base', r.base, 'HEAD').trim()) || 'HEAD'
    const status = new Map(git(r.worktree, 'diff', from, '--name-status').split('\n').filter(Boolean).map(l => { const [st, file] = l.split('\t') as [string, string]; return [file, st[0]] }))
    const tracked = git(r.worktree, 'diff', from, '--numstat').split('\n').filter(Boolean).map(l => {
      const [a, d, file] = l.split('\t') as [string, string, string]
      const st = status.get(file)
      return { repo: r.key, file, added: Number(a) || 0, removed: Number(d) || 0, status: (st === 'A' ? 'A' : st === 'D' ? 'D' : 'M') as Change['status'] }
    })
    const fresh = git(r.worktree, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean).map(file => {
      let n = 0
      try { n = readFileSync(join(r.worktree, file), 'utf8').split('\n').filter((l, i, all) => i < all.length - 1 || l).length } catch {}
      return { repo: r.key, file, added: n, removed: 0, status: 'A' as const }
    })
    return [...tracked, ...fresh]
  })
}

/** a changed file's patch, for the run detail's Diff pane (a file too large to show has none) */
export interface FileDiff { repo: string; file: string; status: 'M' | 'A' | 'D'; added: number; removed: number; patch: string }

/** each file the run changed with its patch: from where its branch left the base to the working tree, new files too */
export function diffs(dataDir: string, run: string, maxLines = 1500): FileDiff[] {
  const f = join(dataDir, 'runs', run, 'run.json')
  if (!existsSync(f)) return []
  const meta = JSON.parse(readFileSync(f, 'utf8')) as { repos?: { key: string; worktree: string; base?: string }[]; repo?: string; worktree?: string; base?: string }
  const repos = meta.repos ?? (meta.worktree ? [{ key: meta.repo ?? 'repo', worktree: meta.worktree, base: meta.base }] : [])
  const git = (cwd: string, ...a: string[]) => new TextDecoder().decode(Bun.spawnSync(['git', ...a], { cwd }).stdout)
  const byFile = new Map(changes(dataDir, run).map(c => [`${c.repo}\0${c.file}`, c]))
  return repos.flatMap(r => {
    if (!existsSync(r.worktree)) return []
    const from = (r.base && git(r.worktree, 'merge-base', r.base, 'HEAD').trim()) || 'HEAD'
    const fresh = git(r.worktree, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean)
    const text = git(r.worktree, 'diff', '--no-color', '--no-ext-diff', from, '--') + fresh.map(file => git(r.worktree, 'diff', '--no-color', '--no-index', '--', '/dev/null', file)).join('')
    return text.split(/^(?=diff --git )/m).filter(p => p.startsWith('diff --git ')).map(patch => {
      const file = /^\+\+\+ b\/(.+)$/m.exec(patch)?.[1] ?? /^--- a\/(.+)$/m.exec(patch)?.[1] ?? /^diff --git a\/(\S+)/.exec(patch)?.[1] ?? '?'
      const c = byFile.get(`${r.key}\0${file}`)
      const big = patch.split('\n').length > maxLines
      return { repo: r.key, file, status: c?.status ?? 'M', added: c?.added ?? 0, removed: c?.removed ?? 0, patch: big ? '' : patch }
    })
  })
}

/** the logs of a run the screen may read: Metro's, the dev server's, the device's */
export const RUN_LOGS = ['metro', 'devserver', 'device'] as const
export type RunLog = (typeof RUN_LOGS)[number]
export type RequestBody = Command | { cmd: 'events'; run: string } | { cmd: 'file'; run: string; name: RunFile } | { cmd: 'transcript'; run: string } | { cmd: 'changes'; run: string } | { cmd: 'diff'; run: string } | { cmd: 'query'; query: Query } | { cmd: 'log'; run: string; name: RunLog; lines: number }
export type Request = RequestBody & { id: number }

export type Message =
  | { type: 'snapshot'; runs: RunState[]; windows: Windows; resources?: Snapshot; recent?: RunEvent[]; projects?: ProjectSummary[] }
  /** not sent: the client's own word that the service went away */
  | { type: 'closed' }
  | { type: 'resources'; resources: Snapshot }
  /** state: null once the run is removed */
  | { type: 'event'; event: RunEvent; state: RunState | null }
  | { type: 'windows'; windows: Windows }
  | { type: 'notice'; notice: Notice }
  | { type: 'agent'; run: string; entry: Entry }
  | { type: 'projects'; projects: ProjectSummary[] }
  | { type: 'reply'; id: number; reply: Reply | { ok: true; events: RunEvent[] } | { ok: true; text: string } | { ok: true; entries: Entry[] } | { ok: true; lines: string[] } | { ok: true; changes: Change[] } | { ok: true; diffs: FileDiff[] } | { ok: true; data: unknown } | { ok: false; error: string } }

type ServiceApi = Pick<Service, 'dispatch' | 'windows' | 'onNotice' | 'onWindows' | 'resources' | 'onResources' | 'projects' | 'onAgent' | 'query' | 'onProjects'>

/** how many of the latest events the screen gets on connect (its Activity) */
export const RECENT = 300

/**
 * The service's socket: localhost only, and only with the token from a file only the user can read; a web page
 * could otherwise reach ws://localhost and send commands.
 */
export function serve(o: { service: ServiceApi; store: EventStore; dataDir: string; port: number; token: string }) {
  const server = Bun.serve<WsData>({
    hostname: '127.0.0.1',
    port: o.port,
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (url.searchParams.get('token') !== o.token) return new Response('refused: wrong token', { status: 401 })
      // a device's video goes over a WebSocket of its own
      const vid = /^\/device\/([\w-][\w.-]*)\/video$/.exec(url.pathname)
      if (vid) {
        const f = join(o.dataDir, 'runs', vid[1]!, 'device.json')
        if (!existsSync(f)) return new Response('this run has no device', { status: 404 })
        const device = JSON.parse(readFileSync(f, 'utf8')) as DeviceState
        return srv.upgrade(req, { data: { device } }) ? undefined : new Response('a WebSocket, please', { status: 400 })
      }
      if (url.pathname.startsWith('/device/')) return deviceRoute(o.dataDir, url.pathname, req)
      if (srv.upgrade(req, { data: {} })) return undefined
      return new Response('flow service: connect with a WebSocket', { status: 400 })
    },
    websocket: {
      async open(ws) {
        const data = ws.data
        if (data.device) {
          const size = await deviceSize(data.device)
          if (!size) { ws.close(1011, 'this device has no video'); return }
          ws.send(JSON.stringify({ type: 'size', ...size }))
          data.stop = video(data.device, size, c => ws.send(c))
          return
        }
        ws.subscribe('all')
        ws.send(JSON.stringify({ type: 'snapshot', runs: o.store.runs(), windows: o.service.windows(), resources: o.service.resources(), recent: o.store.recent(RECENT), projects: o.service.projects() } satisfies Message))
      },
      close(ws) { ws.data.stop?.() },
      async message(ws, raw) {
        if (ws.data.device) return
        let r: Request
        try { r = JSON.parse(String(raw)) } catch { return }
        const reply = (x: Extract<Message, { type: 'reply' }>['reply']) => ws.send(JSON.stringify({ type: 'reply', id: r.id, reply: x } satisfies Message))
        if (r.cmd === 'query') {
          try { reply({ ok: true, data: await o.service.query(r.query) }) } catch (e) { reply({ ok: false, error: (e as Error).message }) }
          return
        }
        if (r.cmd === 'events') { reply({ ok: true, events: o.store.events(r.run) }); return }
        const safe = /^[\w.-]+$/.test(r.cmd === 'transcript' || r.cmd === 'log' || r.cmd === 'file' || r.cmd === 'changes' || r.cmd === 'diff' ? r.run : '')
        if (r.cmd === 'diff') { reply(safe ? { ok: true, diffs: diffs(o.dataDir, r.run) } : { ok: false, error: 'not a run' }); return }
        if (r.cmd === 'changes') { reply(safe ? { ok: true, changes: changes(o.dataDir, r.run) } : { ok: false, error: 'not a run' }); return }
        if (r.cmd === 'transcript') { reply(safe ? { ok: true, entries: readTranscript(o.dataDir, r.run) } : { ok: false, error: 'not a run' }); return }
        if (r.cmd === 'log') {
          if (!RUN_LOGS.includes(r.name) || !safe) { reply({ ok: false, error: `${r.name} is not a run log` }); return }
          reply({ ok: true, lines: tail(join(o.dataDir, 'runs', r.run, `${r.name}.log`), Math.min(Math.max(1, r.lines), 2000)) })
          return
        }
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
    o.store.subscribe(e => publish({ type: 'event', event: e, state: o.store.state(e.run) ?? null })),
    o.service.onNotice(n => publish({ type: 'notice', notice: n })),
    o.service.onWindows(w => publish({ type: 'windows', windows: w })),
    o.service.onResources(r => publish({ type: 'resources', resources: r })),
    o.service.onAgent((run, entry) => publish({ type: 'agent', run, entry })),
    o.service.onProjects(projects => publish({ type: 'projects', projects })),
  ]
  return { port: server.port!, stop: () => { offs.forEach(f => f()); server.stop(true) } }
}

/** a socket's own data: a device's video, or the screen's protocol (none) */
interface WsData { device?: DeviceState; stop?: () => void }

/** a run's device in the browser: /device/<run> the page, …/frame its screen now, …/input (POST) a tap, swipe, key or text */
async function deviceRoute(dataDir: string, path: string, req: globalThis.Request): Promise<Response> {
  const [, , run = '', what = ''] = path.split('/')
  const f = join(dataDir, 'runs', run, 'device.json')
  if (!/^[\w.-]+$/.test(run) || run.startsWith('.') || !existsSync(f)) return new Response('this run has no device', { status: 404 })
  const d = JSON.parse(readFileSync(f, 'utf8')) as DeviceState
  try {
    if (!what) return new Response(screenPage({ run, device: d.id, platform: d.platform }), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    if (what === 'frame') { const fr = await frame(d); return new Response(new Blob([fr.bytes as BlobPart]), { headers: { 'content-type': fr.type, 'cache-control': 'no-store' } }) }
    if (what === 'input' && req.method === 'POST') {
      const i = parseInput(await req.json().catch(() => null))
      if (!i) return new Response('not an input', { status: 400 })
      await send(d, i)
      return new Response(null, { status: 204 })
    }
  } catch (e) { return new Response((e as Error).message, { status: 502 }) }
  return new Response('not found', { status: 404 })
}
