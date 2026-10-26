import { appLog, deviceSize, emulators, frame, parseInput, send, video } from './screen.ts'
import { screenPage } from './screen-page.ts'
import type { DeviceState } from './device.ts'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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

type RunRepo = { key: string; worktree: string; base?: string }
/** the run's repos from its run.json */
function runRepos(dataDir: string, run: string): RunRepo[] {
  const f = join(dataDir, 'runs', run, 'run.json')
  if (!existsSync(f)) return []
  const meta = JSON.parse(readFileSync(f, 'utf8')) as { repos?: RunRepo[]; repo?: string; worktree?: string; base?: string }
  return (meta.repos ?? (meta.worktree ? [{ key: meta.repo ?? 'repo', worktree: meta.worktree, base: meta.base }] : [])).filter(r => existsSync(r.worktree))
}
/** git's output, without holding up the service (every agent's stream goes through it) */
async function git(cwd: string, ...a: string[]): Promise<string> {
  // the worktree can go between the check and the call (the run removed meanwhile): nothing, not an error
  let p: Bun.Subprocess<'ignore', 'pipe', 'ignore'>
  try { p = Bun.spawn(['git', ...a], { cwd, stdout: 'pipe', stderr: 'ignore' }) } catch { return '' }
  const out = await new Response(p.stdout).text()
  await p.exited
  return out
}
/** where a repo's change starts: after the customer patch flow put on it (that is the customer's code), else where the branch left its base */
async function startOf(r: RunRepo, patchCommit?: string): Promise<string> {
  if (patchCommit && (await git(r.worktree, 'cat-file', '-t', patchCommit)).trim() === 'commit') return patchCommit
  return (r.base && (await git(r.worktree, 'merge-base', r.base, 'HEAD')).trim()) || 'HEAD'
}

/** what a run changed in its worktrees so far, committed or not (from where its branch left the base), then new files */
export async function changes(dataDir: string, run: string, patchCommit?: string): Promise<Change[]> {
  const per = await Promise.all(runRepos(dataDir, run).map(async r => {
    const from = await startOf(r, patchCommit)
    const [names, nums, others] = await Promise.all([git(r.worktree, 'diff', from, '--name-status'), git(r.worktree, 'diff', from, '--numstat'), git(r.worktree, 'ls-files', '--others', '--exclude-standard')])
    const status = new Map(names.split('\n').filter(Boolean).map(l => { const [st, file] = l.split('\t') as [string, string]; return [file, st[0]] }))
    const tracked = nums.split('\n').filter(Boolean).map(l => {
      const [a, d, file] = l.split('\t') as [string, string, string]
      const st = status.get(file)
      return { repo: r.key, file, added: Number(a) || 0, removed: Number(d) || 0, status: (st === 'A' ? 'A' : st === 'D' ? 'D' : 'M') as Change['status'] }
    })
    const fresh = await Promise.all(others.split('\n').filter(Boolean).map(async file => {
      let n = 0
      try { n = (await Bun.file(join(r.worktree, file)).text()).split('\n').filter((l, i, all) => i < all.length - 1 || l).length } catch {}
      return { repo: r.key, file, added: n, removed: 0, status: 'A' as const }
    }))
    return [...tracked, ...fresh]
  }))
  return per.flat()
}

/** a changed file's patch, for the run detail's Diff pane (a file too large to show has none) */
export interface FileDiff { repo: string; file: string; status: 'M' | 'A' | 'D'; added: number; removed: number; patch: string }

/** each file the run changed with its patch: from where its branch left the base to the working tree, new files too */
export async function diffs(dataDir: string, run: string, maxLines = 1500, patchCommit?: string): Promise<FileDiff[]> {
  const byFile = new Map((await changes(dataDir, run, patchCommit)).map(c => [`${c.repo}\0${c.file}`, c]))
  const per = await Promise.all(runRepos(dataDir, run).map(async r => {
    const from = await startOf(r, patchCommit)
    const fresh = (await git(r.worktree, 'ls-files', '--others', '--exclude-standard')).split('\n').filter(Boolean)
    const text = (await git(r.worktree, 'diff', '--no-color', '--no-ext-diff', from, '--')) + (await Promise.all(fresh.map(file => git(r.worktree, 'diff', '--no-color', '--no-index', '--', '/dev/null', file)))).join('')
    return text.split(/^(?=diff --git )/m).filter(p => p.startsWith('diff --git ')).map(patch => {
      const file = /^\+\+\+ b\/(.+)$/m.exec(patch)?.[1] ?? /^--- a\/(.+)$/m.exec(patch)?.[1] ?? /^diff --git a\/(\S+)/.exec(patch)?.[1] ?? '?'
      const c = byFile.get(`${r.key}\0${file}`)
      const big = patch.split('\n').length > maxLines
      return { repo: r.key, file, status: c?.status ?? 'M', added: c?.added ?? 0, removed: c?.removed ?? 0, patch: big ? '' : patch }
    })
  }))
  return per.flat()
}

/** the logs of a run the screen may read: Metro's, the dev server's, the device's */
export const RUN_LOGS = ['metro', 'devserver', 'device', 'setup'] as const
export type RunLog = (typeof RUN_LOGS)[number]
export type RequestBody = Command | { cmd: 'events'; run: string } | { cmd: 'file'; run: string; name: RunFile } | { cmd: 'transcript'; run: string } | { cmd: 'changes'; run: string } | { cmd: 'diff'; run: string } | { cmd: 'query'; query: Query } | { cmd: 'log'; run: string; name: RunLog; lines: number } | { cmd: 'tools'; run: string } | { cmd: 'tool'; run: string; name: string; args: Record<string, unknown> }
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

type ServiceApi = Pick<Service, 'dispatch' | 'windows' | 'onNotice' | 'onWindows' | 'resources' | 'onResources' | 'projects' | 'onAgent' | 'query' | 'onProjects'> & Partial<Pick<Service, 'tools' | 'tool'>>

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
        const device = await deviceFor(o.dataDir, vid[1]!)
        if (!device) return new Response('no such device', { status: 404 })
        return srv.upgrade(req, { data: { device } }) ? undefined : new Response('a WebSocket, please', { status: 400 })
      }
      if (url.pathname === '/devices') return Response.json(await deviceList(o.dataDir))
      if (url.pathname.startsWith('/device/')) return deviceRoute(o.dataDir, url.pathname, req)
      if (srv.upgrade(req, { data: {} })) return undefined
      return new Response('flow service: connect with a WebSocket', { status: 400 })
    },
    websocket: {
      async open(ws) {
        const data = ws.data
        if (data.device) {
          const size = await deviceSize(data.device)
          // the page may have gone while adb answered: start nothing for a closed socket
          if (data.closed || ws.readyState !== 1) return
          if (!size) { ws.close(1011, 'this device has no video'); return }
          ws.send(JSON.stringify({ type: 'size', ...size }))
          data.stop = video(data.device, size, c => ws.send(c))
          return
        }
        ws.subscribe('all')
        ws.send(JSON.stringify({ type: 'snapshot', runs: o.store.runs(), windows: o.service.windows(), resources: o.service.resources(), recent: o.store.recent(RECENT), projects: o.service.projects() } satisfies Message))
      },
      close(ws) { ws.data.closed = true; ws.data.stop?.() },
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
        // the run's agent's tools, through its flow MCP server
        if (r.cmd === 'tools') { try { reply({ ok: true, data: o.service.tools?.(r.run) ?? [] }) } catch (e) { reply({ ok: false, error: (e as Error).message }) } return }
        if (r.cmd === 'tool') { try { reply({ ok: true, data: await o.service.tool!(r.run, r.name, r.args ?? {}) }) } catch (e) { reply({ ok: false, error: (e as Error).message }) } return }
        const safe = /^[\w.-]+$/.test(r.cmd === 'transcript' || r.cmd === 'log' || r.cmd === 'file' || r.cmd === 'changes' || r.cmd === 'diff' ? r.run : '')
        const patch = safe && 'run' in r ? o.store.state(r.run)?.patch?.commit : undefined
        if (r.cmd === 'diff') { reply(safe ? { ok: true, diffs: await diffs(o.dataDir, r.run, 1500, patch) } : { ok: false, error: 'not a run' }); return }
        if (r.cmd === 'changes') { reply(safe ? { ok: true, changes: await changes(o.dataDir, r.run, patch) } : { ok: false, error: 'not a run' }); return }
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
interface WsData { device?: DeviceState; stop?: () => void; closed?: boolean }

/** a run's device in the browser: /device/<run> the page, …/frame its screen now, …/input (POST) a tap, swipe, key or text */
async function deviceRoute(dataDir: string, path: string, req: globalThis.Request): Promise<Response> {
  const [, , name = '', what = ''] = path.split('/')
  const d = await deviceFor(dataDir, name)
  if (!d) return new Response('no such device', { status: 404 })
  const run = name
  try {
    if (!what) return new Response(screenPage({ run, device: d.id, platform: d.platform }), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    if (what === 'log') return new Response((await appLog(d, new URL(req.url).searchParams.get('all') === '1')).join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
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

/** a device by its run (the run's own), or by an emulator's id that adb sees (one no run holds: yours, another tool's) */
async function deviceFor(dataDir: string, name: string): Promise<DeviceState | null> {
  if (!/^[\w-][\w.-]*$/.test(name)) return null
  const f = join(dataDir, 'runs', name, 'device.json')
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')) as DeviceState
  if (/^emulator-\d+$/.test(name) && (await emulators()).includes(name)) return { run: name, platform: 'android', id: name, consolePort: Number(name.slice(9)), metroPort: 0, pids: [] }
  return null
}

/** every device to see: the runs' own, then emulators no run holds */
async function deviceList(dataDir: string): Promise<{ name: string; label: string }[]> {
  const runs = join(dataDir, 'runs')
  const own = (existsSync(runs) ? readdirSync(runs) : []).filter(r => !r.startsWith('.') && existsSync(join(runs, r, 'device.json'))).map(r => ({ name: r, d: JSON.parse(readFileSync(join(runs, r, 'device.json'), 'utf8')) as DeviceState }))
  const held = new Set(own.map(x => x.d.id))
  return [...own.map(x => ({ name: x.name, label: `${x.name} · ${x.d.platform} ${x.d.id}` })), ...(await emulators().catch(() => [])).filter(e => !held.has(e)).map(e => ({ name: e, label: `${e} · not a flow run` }))]
}
