import { useKeyboard, usePaste, useTerminalDimensions } from '@opentui/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { KeyEvent } from '@opentui/core'
import { RunDetail, stopShells, type DetailApi, type DetailKeys, type PaletteAction } from './detail.tsx'
import { NewRunForm, type FormApi } from './form.tsx'
import { ProjectSettings } from './settings.tsx'
import type { RunEvent, RunState } from '../run.ts'
import type { RunFile } from '../server.ts'
import type { Command, ProjectSummary, Reply } from '../service.ts'
import type { Windows } from '../usage.ts'
import { WAITS_FOR, type Snapshot } from '../resources.ts'
import {
  activity, attention, duration, filterRuns, line, footer, groupRows, header, hhmm, lastMessage, layout, match, resourceBars, rank, rows, SORTS, tokens,
  type AttentionItem, type Grouped, type Row, type Sort,
} from './model.ts'

/** What the screen needs from the service connection (FlowClient implements it). */
export interface FlowApi extends DetailApi, FormApi {
  runs: Map<string, RunState>
  windows: Windows
  resources?: Snapshot
  /** the latest events of all runs, oldest first */
  recent?: RunEvent[]
  projects?: ProjectSummary[]
  connected?: boolean
  listen(fn: (m: { type: string; notice?: { run: string; text: string }; run?: string; entry?: import('../transcript.ts').Entry }) => void): () => void
  send(c: Command): Promise<Reply>
}

// colour only for state (the design's tokens); the terminal's own background shows through
const C = { text: '#DDE2E8', secondary: '#A3ABB5', muted: '#6D7681', faint: '#434A54', accent: '#78A6EC', success: '#72C08A', warning: '#E2B35F', danger: '#EC7A70', selected: '#1B2533', inactive: '#171B21', panel: '#161A20' }
const TONE = { accent: C.accent, warning: C.warning, danger: C.danger, success: C.success, muted: C.muted }

const fit = (s: string, n: number) => (n <= 0 ? '' : s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n))
const fitL = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s.padStart(n))

const TABS = ['Runs', 'Queue', 'Metrics', 'Projects'] as const
type Tab = (typeof TABS)[number]

type Mode =
  | { kind: 'list' }
  // back: asked from the run's detail, which stays on screen and comes back afterwards
  | { kind: 'approve'; run: string; editing: boolean; text: string; back?: boolean }
  | { kind: 'ship'; run: string; back?: boolean }
  | { kind: 'message'; run: string; text: string; back?: boolean }
  | { kind: 'new' }
  | { kind: 'settings'; project: string }
  | { kind: 'detail'; run: string }
  | { kind: 'filter'; text: string }
  | { kind: 'projects'; index: number }


/** an entry of the command palette: what it says, and what choosing it does */
interface Action { label: string; hint?: string; run: () => void }


export function App({ api, now = Date.now, onQuit = () => process.exit(0) }: { api: FlowApi; now?: () => number; onQuit?: () => void }) {
  const [, setTick] = useState(0)
  const [selected, setSelected] = useState(0)
  const [mode, setMode] = useState<Mode>({ kind: 'list' })
  const [notice, setNotice] = useState<string | null>(null)
  const detailKeys = useRef<DetailKeys | null>(null)
  const formKeys = useRef<DetailKeys | null>(null)
  const settingsKeys = useRef<DetailKeys | null>(null)
  /** where pasted text goes in a form, the settings or a run's detail (each knows its field being typed in) */
  const pasteTo = useRef<((text: string, bytes: Uint8Array) => void) | null>(null)
  const [projSel, setProjSel] = useState(0)
  /** the run detail's own commands, for the palette while it is open */
  const detailCmds = useRef<(() => PaletteAction[]) | null>(null)
  /** the command palette: over whatever is open (the runs, a tab, a run's detail), which stays as it is */
  const [pal, setPal] = useState<{ text: string; index: number } | null>(null)
  const [tab, setTab] = useState<Tab>('Runs')
  const [sort, setSort] = useState<Sort>('newest')
  const [grouped, setGrouped] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  /** where j/k, enter and the action keys go: the runs table, or the Needs attention list */
  const [focus, setFocus] = useState<'runs' | 'attention'>('runs')
  const [attSel, setAttSel] = useState(0)
  const [hover, setHover] = useState<string | null>(null)
  const { width, height } = useTerminalDimensions()

  useEffect(() => api.listen(m => {
    if (m.type === 'notice' && m.notice) setNotice(`${m.notice.run}: ${m.notice.text}`)
    if (m.type === 'closed') setNotice('the flow service stopped: start flow again')
    setTick(t => t + 1)
  }), [api])
  // the clock moves even when nothing happens (elapsed times, deadlines)
  useEffect(() => { const t = setInterval(() => setTick(x => x + 1), 30_000); return () => clearInterval(t) }, [])

  const t = now()
  const all = [...api.runs.values()]
  const shown = filterRuns(all, filter, t)
  const list = rows(shown, t, sort)
  const items: Grouped[] = grouped ? groupRows(list, shown, collapsed) : list.map(row => ({ kind: 'row', row }))
  const att = attention(all, t)
  const h = header(all, api.windows, t)
  const L = layout(width, height, att.length)
  const sel = Math.min(selected, Math.max(0, items.length - 1))
  const item = items[sel]
  const current = item?.kind === 'row' ? item.row : undefined
  const attFocused = focus === 'attention' && att.length ? att[Math.min(attSel, att.length - 1)] : undefined
  // the run on screen: the detail's own (also while one of its confirms is up), else the one selected in a list
  const detailId = mode.kind === 'detail' || ('back' in mode && mode.back) ? (mode as { run: string }).run : undefined
  const state = detailId ? api.runs.get(detailId) : attFocused ? api.runs.get(attFocused.run) : current ? api.runs.get(current.run) : undefined
  const after = (m: Mode): Mode => ('back' in m && m.back ? { kind: 'detail', run: m.run } : { kind: 'list' })
  // the project picker: every project the service knows or a run belongs to, with its runs
  const projectKeys = [...new Set([...(api.projects ?? []).map(p => p.key), ...all.map(r => r.project)])]
  const choices = [{ key: '', name: 'all projects', count: all.length }, ...projectKeys.map(k => ({ key: k, name: api.projects?.find(p => p.key === k)?.name ?? '', count: all.filter(r => r.project === k).length }))]
  const pickProject = (key: string) => {
    const rest = filter.split(/\s+/).filter(w => w && !w.startsWith('project:'))
    setFilter([...(key ? [`project:${key}`] : []), ...rest].join(' '))
    setSelected(0); setMode({ kind: 'list' })
  }
  const recent = api.recent ?? []


  /** true when the service took it; a refused new run keeps its form open with what was typed */
  const send = async (c: Command, done: string): Promise<boolean> => {
    const r = await api.send(c)
    setNotice(r.ok ? done : r.error)
    setMode(m => (m.kind === 'detail' || (m.kind === 'new' && !r.ok) ? m : after(m)))
    return r.ok
  }

  // what a key (or the palette) does to a run
  const ask = {
    approve: (r: RunState) => (r.needs?.kind === 'plan' ? setMode({ kind: 'approve', run: r.id, editing: false, text: '', back: !!detailId }) : setNotice(`${r.ticket}: no plan is waiting for you`)),
    ship: (r: RunState) => (r.needs?.kind === 'ship' || (r.needs?.kind === 'patch' && r.patch) ? setMode({ kind: 'ship', run: r.id, back: !!detailId }) : setNotice(`${r.ticket} is not ready to ship`)),
    message: (r: RunState) => setMode({ kind: 'message', run: r.id, text: '', back: !!detailId }),
    port: (r: RunState) => (r.pr ? void send({ cmd: 'port', run: r.id }, `porting ${r.ticket} to develop`) : setNotice(`${r.ticket} has no draft PR to port yet`)),
    release: (r: RunState) => (r.device ? void send({ cmd: 'release', run: r.id }, `stopping ${r.ticket}'s device`) : setNotice(`${r.ticket} has no device`)),
    open: (r: RunState) => setMode({ kind: 'detail', run: r.id }),
  }
  const goTab = (x: Tab) => { setTab(x); setMode({ kind: 'list' }) }

  // the commands: in a run's detail that run's own; elsewhere the screen's, and every run to open by its ticket or title
  const actions = (): Action[] => {
    const a: Action[] = []
    const inDetail = mode.kind === 'detail' ? api.runs.get(mode.run) : undefined
    if (inDetail) {
      const r = inDetail
      if (r.needs?.kind === 'plan') a.push({ label: 'Approve the plan', hint: 'a · with the defaults, or other answers', run: () => ask.approve(r) })
      if (r.needs?.kind === 'ship' || r.needs?.kind === 'patch') a.push({ label: r.patch ? (r.needs.kind === 'patch' ? 'Write the patch back' : 'Check the write-back') : 'Ship', hint: r.patch ? 'S' : 'S · commit, push, draft PR', run: () => ask.ship(r) })
      a.push(...(detailCmds.current?.() ?? []))
      if (r.pr) a.push({ label: 'Port to develop', hint: 'p', run: () => ask.port(r) })
      if (r.device || r.devServer) a.push({ label: 'Stop the device and dev server', hint: [r.device ? `${r.device.platform} ${r.device.id}` : '', r.devServer ? r.devServer.url : ''].filter(Boolean).join(' · '), run: () => ask.release(r) })
      a.push({ label: 'Back to the runs', hint: 'esc', run: () => setMode({ kind: 'list' }) })
      a.push({ label: 'Quit', hint: 'q', run: () => { stopShells(); onQuit() } })
      return a
    }
    a.push({ label: 'New run', hint: 'n', run: () => setMode({ kind: 'new' }) })
    a.push({ label: 'Choose a project', hint: 'p', run: () => setMode({ kind: 'projects', index: 0 }) })
    // runs of one ticket (a release fix and its port) are told apart by their line
    for (const r of all.filter(x => x.status !== 'done' || x.updatedAt > t - 86_400_000)) a.push({ label: `Open ${r.ticket} ${line(r.base)} ${r.title}`, hint: `${r.project} · ${r.stage} · ${r.status}`, run: () => ask.open(r) })
    a.push({ label: 'Show runs that need you', hint: 'status:needs-you', run: () => { setFilter('status:needs-you'); goTab('Runs') } })
    a.push({ label: 'Show failed and blocked runs', hint: 'status:failed', run: () => { setFilter('status:failed'); goTab('Runs') } })
    for (const p of api.projects ?? []) a.push({ label: `Show ${p.name} runs`, hint: `project:${p.key}`, run: () => { setFilter(`project:${p.key}`); goTab('Runs') } })
    if (filter) a.push({ label: 'Clear the filter', hint: filter, run: () => { setFilter(''); setMode({ kind: 'list' }) } })
    a.push({ label: grouped ? 'Stop grouping' : 'Group by stage', run: () => { setGrouped(g => !g); setMode({ kind: 'list' }) } })
    for (const x of SORTS) if (x !== sort) a.push({ label: `Sort by ${x}`, run: () => { setSort(x); setMode({ kind: 'list' }) } })
    for (const x of TABS) if (x !== tab) a.push({ label: `Go to ${x}`, hint: String(TABS.indexOf(x) + 1), run: () => goTab(x) })
    a.push({ label: 'Quit', hint: 'q', run: () => { stopShells(); onQuit() } })
    return a
  }
  // the best fits first: what you typed as written in the label, then word starts, then letters in order
  const found = pal ? actions().map((x, i) => ({ x, i, r: Math.min(...[rank(pal.text, x.label), rank(pal.text, `${x.label} ${x.hint ?? ''}`) + 0.5].filter(n => n >= 0), Infinity) }))
    .filter(y => y.r !== Infinity).sort((a, b) => a.r - b.r || a.i - b.i).map(y => y.x) : []

  /** a key, from the keyboard or from a click on its hint: name for special keys (return, escape, …), typed for characters */
  const handle = (name: string, typed: string, ctrl = false, raw?: KeyEvent) => {
    const key = { ctrl }
    // the palette, when open, takes every key; what is under it stays as it was
    if (pal) {
      if (name === 'down' || (ctrl && name === 'n')) return setPal(p => p && { ...p, index: Math.min(p.index + 1, Math.max(0, found.length - 1)) })
      if (name === 'up' || (ctrl && name === 'p')) return setPal(p => p && { ...p, index: Math.max(p.index - 1, 0) })
      if (name === 'pagedown') return setPal(p => p && { ...p, index: Math.min(p.index + 10, Math.max(0, found.length - 1)) })
      if (name === 'pageup') return setPal(p => p && { ...p, index: Math.max(p.index - 10, 0) })
      if (name === 'return') { const a = found[pal.index]; setPal(null); a?.run(); return }
      if (name === 'backspace') return setPal(p => p && { text: p.text.slice(0, -1), index: 0 })
      if (name === 'escape' || (ctrl && name === 'k')) return setPal(null)
      if (typed) setPal(p => p && { text: p.text + typed, index: 0 })
      return
    }
    // in a run's detail its panes take the keys first (a shell or the message box being typed in takes them all)
    if (mode.kind === 'detail' && raw && detailKeys.current?.(raw, typed)) return
    if (mode.kind === 'new') { if (raw) formKeys.current?.(raw, typed); return }
    if (mode.kind === 'settings' && raw && settingsKeys.current?.(raw, typed)) return    // typing goes through the latest state: keys can arrive faster than the screen redraws
    const edit = (f: (text: string) => string) => setMode(prev => ('text' in prev ? ({ ...prev, text: f(prev.text) } as Mode) : prev))
    const input = (m: Extract<Mode, { text: string }>, enter: (text: string) => void) => {
      if (name === 'escape') return setMode(after(m))
      if (name === 'backspace') return edit(x => x.slice(0, -1))
      if (name === 'return') return enter(m.text)
      if (typed) edit(x => x + typed)
    }
    if (mode.kind === 'projects') {
      if (name === 'down' || typed === 'j') return setMode({ kind: 'projects', index: Math.min(mode.index + 1, choices.length - 1) })
      if (name === 'up' || typed === 'k') return setMode({ kind: 'projects', index: Math.max(mode.index - 1, 0) })
      if (name === 'return') return pickProject(choices[mode.index]!.key)
      if (name === 'escape' || typed === 'p') return setMode({ kind: 'list' })
      return
    }
    if (mode.kind === 'filter') return input(mode, text => { setFilter(text.trim()); setSelected(0); setMode({ kind: 'list' }) })
    if (mode.kind === 'message') return input(mode, text => { if (text.trim()) void send({ cmd: 'message', run: mode.run, text: text.trim() }, `message sent to ${mode.run}`) })
    if (mode.kind === 'approve' && mode.editing) return input(mode, text => {
      if (!text.trim()) return
      // Q1=only the list Q2=no: an answer runs up to the next question's id
      const answers = Object.fromEntries(text.trim().split(/\s+(?=Q\d+\s*=)/i).map(p => [p.slice(0, p.indexOf('=')).trim().toUpperCase(), p.slice(p.indexOf('=') + 1).trim()]).filter(([k, v]) => /^Q\d+$/.test(k!) && v))
      void send({ cmd: 'approve', run: mode.run, answers }, `plan approved: ${mode.run}`)
    })
    if (mode.kind === 'approve') {
      if (typed === 'y') return void send({ cmd: 'approve', run: mode.run }, `plan approved with the defaults: ${mode.run}`)
      if (typed === 'e') return setMode({ ...mode, editing: true, text: '' })
      if (typed === 'n' || name === 'escape') return setMode(after(mode))
      return
    }
    if (mode.kind === 'ship') {
      if (typed === 'y') {
        const r = api.runs.get(mode.run)
        const what = !r?.patch ? 'commit, push, draft PR' : r.needs?.kind === 'patch' ? 'writing the patch back' : 'write-back dry run'
        return void send({ cmd: 'ship', run: mode.run }, `shipping ${mode.run}: ${what}`)
      }
      if (typed === 'n' || name === 'escape') return setMode(after(mode))
      return
    }
    if ((key.ctrl && name === 'k') || typed === ':') return setPal({ text: '', index: 0 })
    if (name === 'escape' && mode.kind === 'detail') return setMode({ kind: 'list' })
    if (name === 'escape' && focus === 'attention') return setFocus('runs')
    if (name === 'escape' && filter) { setFilter(''); return }
    if (typed === 'q') { stopShells(); return onQuit() }
    if (typed >= '1' && typed <= String(TABS.length)) return goTab(TABS[Number(typed) - 1]!)
    if (typed === 'p' && mode.kind !== 'detail') return setMode({ kind: 'projects', index: Math.max(0, choices.findIndex(c => c.key === (/project:(\S+)/.exec(filter)?.[1] ?? ''))) })
    if (typed === 'n') return setMode({ kind: 'new' })
    if (tab === 'Projects' && mode.kind === 'list') {
      const n = (api.projects ?? []).length
      if (name === 'down' || typed === 'j') return setProjSel(i => Math.min(i + 1, Math.max(0, n - 1)))
      if (name === 'up' || typed === 'k') return setProjSel(i => Math.max(i - 1, 0))
      const p = (api.projects ?? [])[Math.min(projSel, n - 1)]
      if (name === 'return' && p) return setMode({ kind: 'settings', project: p.key })
      return
    }
    // the detail has its own keys: the list's (move, sort, group, filter) don't reach the list behind it
    if (mode.kind === 'detail') {
      if (!state) return
      if (typed === 'a') return ask.approve(state)
      if (typed === 'S') return ask.ship(state)
      if (typed === 'p') return ask.port(state)
      return
    }
    if (tab !== 'Runs') return
    if (name === 'tab') return setFocus(f => (f === 'runs' && att.length ? 'attention' : 'runs'))
    // one cursor through both lists: down past the last item needing you goes into the runs, up from the first run back
    if (focus === 'attention') {
      const at = Math.min(attSel, att.length - 1)
      if (name === 'down' || typed === 'j') { if (at >= att.length - 1 && items.length) { setFocus('runs'); setSelected(0) } else setAttSel(at + 1); return }
      if (name === 'up' || typed === 'k') return setAttSel(Math.max(at - 1, 0))
    } else {
      if (name === 'down' || typed === 'j') return setSelected(Math.min(sel + 1, items.length - 1))
      if (name === 'up' || typed === 'k') { if (sel === 0 && att.length && tab === 'Runs') { setFocus('attention'); setAttSel(att.length - 1) } else setSelected(Math.max(sel - 1, 0)); return }
    }
    if (typed === 's') return setSort(SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length]!)
    if (typed === 'g') { setGrouped(g => !g); setSelected(0); return }
    if (typed === '/') return setMode({ kind: 'filter', text: filter })
    if (name === 'return' && focus === 'runs' && item?.kind === 'group') { const next = new Set(collapsed); next.has(item.stage) ? next.delete(item.stage) : next.add(item.stage); setCollapsed(next); return }
    if (!state) return
    if (name === 'return') return ask.open(state)
    if (typed === 'a') return ask.approve(state)
    if (typed === 'S') return ask.ship(state)
    if (typed === 'm') return ask.message(state)
  }
  useKeyboard(key => handle(key.name, key.sequence && key.sequence.length === 1 && key.sequence >= ' ' ? key.sequence : '', key.ctrl, key))
  // pasted text: into whatever is being typed in (one line where a field has one); never read as keys on the runs
  usePaste(e => {
    const bytes = e.bytes, text = new TextDecoder().decode(bytes)
    const line = text.replace(/\r?\n/g, ' ').trim()
    if (pal) return setPal(p => p && { text: p.text + line, index: 0 })
    if (mode.kind === 'new' || mode.kind === 'settings' || mode.kind === 'detail') return pasteTo.current?.(text, bytes)
    if (mode.kind === 'filter' || mode.kind === 'message' || (mode.kind === 'approve' && mode.editing)) setMode(m => ('text' in m ? ({ ...m, text: m.text + line } as Mode) : m))
  })

  // the mouse: a click selects (a second click on the selected run opens it), the wheel moves the selection
  const clickItem = (i: number) => {
    const x = items[i]
    if (!x) return
    setSelected(i)
    if (x.kind === 'group') { const next = new Set(collapsed); next.has(x.stage) ? next.delete(x.stage) : next.add(x.stage); setCollapsed(next) }
    else if (i === sel && focus === 'runs' && mode.kind === 'list') ask.open(api.runs.get(x.row.run)!)
    setFocus('runs')
  }
  const scroll = (down: boolean) => setSelected(x => Math.max(0, Math.min(Math.min(x, items.length - 1) + (down ? 1 : -1), items.length - 1)))
  const clickAttention = (a: AttentionItem, act: boolean) => {
    setFocus('attention'); setAttSel(att.findIndex(x => x.run === a.run))
    const r = api.runs.get(a.run)
    if (act && r) ask[a.action](r)
  }

  if (L.tooSmall) return <box paddingLeft={1}><text fg={C.warning}>{L.text}</text></box>

  const bars = api.resources ? resourceBars(api.resources) : []
  const inline = mode.kind === 'approve' || mode.kind === 'ship' ? mode.run : undefined
  const message = notice ?? (L.message ? lastMessage(recent, t) : '')
  if (mode.kind === 'settings') return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Tabs tab={tab} names={L.tabNames} filter={filter} connected={api.connected !== false} onTab={i => handle('', String(i + 1))} onProject={() => {}} />
      <ProjectSettings api={api} project={mode.project} width={width} height={height} bind={k => { settingsKeys.current = k }} bindPaste={f => { pasteTo.current = f }}
        onBack={() => setMode({ kind: 'list' })} onSaved={text => setNotice(text)} />
      {pal ? <Palette text={pal.text} found={found} index={pal.index} width={width} title="commands" onPick={a => { setPal(null); a.run() }} onIndex={i => setPal(p => p && { ...p, index: i })} /> : null}
    </box>
  )
  const detailRun = detailId ? api.runs.get(detailId) : undefined
  if (detailRun) return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Tabs tab={tab} names={L.tabNames} filter={filter} connected={api.connected !== false} onTab={i => handle('', String(i + 1))} onProject={() => handle('', 'p')} />
      <RunDetail api={api} run={detailRun} now={t} width={width} height={height} message={message} bind={k => { detailKeys.current = k }}
        onMessage={text => send({ cmd: 'message', run: detailRun.id, text }, `message sent to ${detailRun.id}`)} onBack={() => setMode({ kind: 'list' })} onKey={k => (k === 'palette' ? handle('k', '', true) : handle('', k))} bindCommands={c => { detailCmds.current = c }} bindPaste={f => { pasteTo.current = f }} />
      {inline ? <Confirm mode={mode} run={detailRun} resources={api.resources} onKey={k => handle('', k)} /> : null}
      {mode.kind === 'message' ? <Bar mode={mode} run={detailRun} message="" compact={!L.tabNames} tab={tab} onKey={handle} /> : null}
      {pal ? <Palette text={pal.text} found={found} index={pal.index} width={width} title={`${detailRun.ticket} commands`} onPick={a => { setPal(null); a.run() }} onIndex={i => setPal(p => p && { ...p, index: i })} /> : null}
    </box>
  )
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Tabs tab={tab} names={L.tabNames} filter={filter} connected={api.connected !== false} onTab={i => handle('', String(i + 1))} onProject={() => handle('', 'p')} />
      <text>
        <span fg={C.accent}>● </span><span fg={C.text}>{h.active}</span><span fg={C.muted}> active   </span>
        <span fg={C.warning}>▲ </span><span fg={C.text}>{h.needYou}</span><span fg={C.muted}> need you   </span>
        <span fg={C.secondary}>◌ </span><span fg={C.text}>{h.waiting}</span><span fg={C.muted}> waiting   </span>
        {bars.filter(b => b.kind !== 'agents').map(b => <span key={b.kind} fg={b.full ? C.warning : C.muted}>{`${b.label.toLowerCase()} `}<span fg={C.text}>{`${b.holders.length}/${b.used.length}`}</span>{'   '}</span>)}
        <span fg={C.muted}>5h </span><span fg={C.text}>{h.fiveHour}</span><span fg={C.muted}>{h.fiveHourReset && L.tabNames ? ` (resets ${h.fiveHourReset})` : ''}   week </span><span fg={C.text}>{h.week}</span>
      </text>
      <text> </text>
      {tab === 'Runs' ? (
          <>
            <Attention items={att} shown={L.attentionShown} two={L.twoLineAttention} inline={inline} mode={mode} runs={api.runs} resources={api.resources} onItem={clickAttention} onKey={k => handle('', k)}
              focused={attFocused?.run} hover={hover} onHover={setHover} />
            <text> </text>
            <box flexDirection="row">
              <text><strong>Runs</strong><span fg={C.muted}> {filter ? `${shown.length} of ${all.length}` : shown.length}   </span></text>
              <Click on={() => handle('', 's')}><text><strong>s</strong><span fg={C.muted}> sort </span><span fg={C.secondary}>{sort}   </span></text></Click>
              <Click on={() => handle('', 'g')}><text><strong>g</strong><span fg={C.muted}> group </span><span fg={C.secondary}>{grouped ? 'stage' : 'none'}   </span></text></Click>
              <Click on={() => handle('', '/')}><text><strong>/</strong><span fg={C.muted}> filter </span><span fg={filter ? C.accent : C.secondary}>{filter || 'none'}</span></text></Click>
            </box>
            <Table items={items} selected={sel} rowsShown={L.tableRows} width={width - 2} cols={{ project: L.project, tokens: L.tokens, track: L.track }} onClick={clickItem} onScroll={scroll}
              active={focus === 'runs'} hover={hover} onHover={setHover} />
            <text fg={C.muted}>{list.length ? footer(all, shown, filter, t) : ''}</text>
            {L.bottom ? (L.split
              ? <Bottom bars={bars} waiting={api.resources?.waiting ?? []} feed={state ? activity(recent, state.id).slice(0, 5) : []} run={state?.ticket} width={width - 2} runs={api.runs} windows={api.windows} now={t} />
              : <><text> </text><ResourcesLine bars={bars} /></>) : null}
          </>
        ) : tab === 'Queue' ? <QueueView runs={all} resources={api.resources} now={t} />
        : tab === 'Metrics' ? <MetricsView runs={all} projects={api.projects ?? []} />
        : <ProjectsView projects={api.projects ?? []} runs={all} selected={projSel} onOpen={i => { if (i === projSel) { const p = (api.projects ?? [])[i]; if (p) setMode({ kind: 'settings', project: p.key }) } else setProjSel(i) }} />}
      <text> </text>
      {mode.kind === 'new' ? <NewRunForm api={api} width={width} project={/project:(\S+)/.exec(filter)?.[1] ?? [...all].sort((x, y) => y.createdAt - x.createdAt)[0]?.project} fixed={/project:(\S+)/.test(filter)} bind={k => { formKeys.current = k }} bindPaste={f => { pasteTo.current = f }}
        onStart={c => void send(c, `starting ${c.project}-${c.ticket}`)} onCancel={() => setMode({ kind: 'list' })} /> : null}
      {mode.kind === 'projects' ? <ProjectPicker choices={choices} index={mode.index} current={/project:(\S+)/.exec(filter)?.[1] ?? ''} onPick={pickProject} /> : null}
      {pal ? <Palette text={pal.text} found={found} index={pal.index} width={width} title="commands" onPick={a => { setPal(null); a.run() }} onIndex={i => setPal(p => p && { ...p, index: i })} /> : null}
      <Bar mode={mode} run={mode.kind === 'message' ? api.runs.get(mode.run) : undefined} message={message} compact={!L.tabNames} tab={tab} onKey={handle} />
    </box>
  )
}

/** something the mouse can press */
function Click({ on, children }: { on: () => void; children: ReactNode }) {
  return <box onMouseDown={on}>{children}</box>
}

function Tabs({ tab, names, filter, connected, onTab, onProject }: { tab: Tab; names: boolean; filter: string; connected: boolean; onTab: (i: number) => void; onProject: () => void }) {
  const project = /project:(\S+)/.exec(filter)?.[1]
  return (
    <box flexDirection="row">
      <text><span fg={C.accent}>∿ </span><strong>flow</strong>{'  '}</text>
      <Click on={onProject}><text>{project ? <strong fg={C.accent}>{project}</strong> : <span fg={C.secondary}>all projects</span>}<span fg={C.muted}> ▾   </span></text></Click>
      {TABS.map((x, i) => (
        <Click key={x} on={() => onTab(i)}>
          {x === tab ? <text><strong>{`${i + 1} ${x}`}</strong>{'  '}</text> : <text fg={C.muted}>{names ? `${i + 1} ${x}  ` : `${i + 1}  `}</text>}
        </Click>
      ))}
      <text><span fg={connected ? C.success : C.danger}>{'  ● '}</span><span fg={C.muted}>{connected ? 'connected' : 'disconnected'}</span></text>
    </box>
  )
}

function Attention({ items, shown, two, inline, mode, runs, resources, onItem, onKey, focused, hover, onHover }: { items: AttentionItem[]; shown: number; two: boolean; inline?: string; mode: Mode; runs: Map<string, RunState>; resources?: Snapshot; onItem: (a: AttentionItem, act: boolean) => void; onKey: (k: string) => void; focused?: string; hover: string | null; onHover: (run: string | null) => void }) {
  // the focused item and the ones before it stay in view, however few lines there are
  const upTo = Math.max(shown, inline ? items.findIndex(a => a.run === inline) + 1 : 0, focused ? items.findIndex(a => a.run === focused) + 1 : 0)
  return (
    <box flexDirection="column">
      <text>{focused ? <strong fg={C.accent}>▌Needs attention</strong> : <strong>Needs attention</strong>}<span fg={C.warning}> {items.length}</span>{items.length ? <span fg={C.faint}>{focused ? '   ⇥ back to the runs' : '   ⇥ focus'}   held first, then by deadline</span> : null}</text>
      {items.length ? items.slice(0, upTo).map(a => (
        <box key={a.run} flexDirection="column" backgroundColor={focused === a.run ? C.selected : hover === `a:${a.run}` ? C.panel : undefined}
          onMouseOver={() => onHover(`a:${a.run}`)} onMouseOut={() => onHover(null)}>
          <box flexDirection="row">
            <Click on={() => onItem(a, false)}>
              <text>
                <span fg={C.accent}>{focused === a.run ? '▌' : ' '}</span><span fg={C.secondary}>{fit(a.ticket, 9)}</span> <strong>{fit(a.title, two ? 34 : 26)}</strong> {two ? <span fg={C.muted}>{fit(a.line, 9)}</span> : null}
                <span fg={TONE[a.tone]}> ◆ {fit(a.label, 15)}</span><span fg={C.secondary}>{fit(a.when, 18)}</span>
              </text>
            </Click>
            <Click on={() => onItem(a, true)}><text><strong>{a.key}</strong><span fg={C.secondary}> {a.action}</span></text></Click>
          </box>
          {two ? <Click on={() => onItem(a, false)}><text fg={C.muted}>{`          ${a.detail.slice(0, 110)}`}</text></Click> : null}
          {inline === a.run ? <Confirm mode={mode} run={runs.get(a.run)} resources={resources} onKey={onKey} /> : null}
        </box>
      )) : <text fg={C.muted}>Nothing needs you.</text>}
      {items.length > Math.max(upTo, 1) ? <text fg={C.faint}>{`          and ${items.length - upTo} more · ⇥ then j to reach them`}</text> : null}
    </box>
  )
}

/** the confirm under the item it acts on: what happens, and what it will wait for */
/** a key and what it does, pressable */
function Hint({ k, label, tone = C.secondary, on }: { k: string; label: string; tone?: string; on: () => void }) {
  return <Click on={on}><text><strong>{k}</strong><span fg={tone}>{` ${label}`}</span><span>{'   '}</span></text></Click>
}

function Confirm({ mode, run, resources, onKey }: { mode: Mode; run?: RunState; resources?: Snapshot; onKey: (k: string) => void }) {
  if (!run) return null
  const builds = resources ? resources.holders.builds.length >= resources.limits.builds : false
  const queue = builds ? ` Builds are full, so ${run.ticket} waits for a build slot${resources!.waiting.length ? ` (${resources!.waiting.length} waiting)` : ''}.` : ''
  if (mode.kind === 'approve' && mode.editing) return <text>{'          '}<span fg={C.warning}>Answers </span><span fg={C.text}>{mode.text}▏</span><span fg={C.muted}>   e.g. Q1=yes Q2=no · ↵ approve · esc cancel</span></text>
  if (mode.kind === 'approve') return (
    <box flexDirection="column">
      <text>{'          '}<strong>{`Approve ${run.ticket} with the defaults and start the build?`}</strong><span fg={C.secondary}>{queue}</span></text>
      {(run.plan?.questions ?? []).map(q => <text key={q.id} fg={C.secondary}>{`            ${q.id}${q.held ? ' (held)' : ''} ${q.text} → ${q.default}`}</text>)}
      <box flexDirection="row"><text>{'          '}</text><Hint k="y" label="approve" tone={C.warning} on={() => onKey('y')} /><Hint k="e" label="other answers" on={() => onKey('e')} /><Hint k="n" label="cancel" on={() => onKey('n')} /></box>
    </box>
  )
  if (mode.kind === 'ship' && run.patch) {
    const real = run.needs?.kind === 'patch'
    return <box flexDirection="row"><text>{'          '}<strong>{real ? `Write the patch back for ${run.ticket}?` : `Check the write-back for ${run.ticket}?`}</strong><span fg={C.secondary}>{real ? ' the patch and the fix, as the dry run showed   ' : ' a dry run, nothing written   '}</span></text><Hint k="y" label={real ? 'write back' : 'check'} tone={C.success} on={() => onKey('y')} /><Hint k="n" label="cancel" on={() => onKey('n')} /></box>
  }
  if (mode.kind === 'ship') return <box flexDirection="row"><text>{'          '}<strong>{`Ship ${run.ticket}?`}</strong><span fg={C.secondary}> commit, push, open a draft PR   </span></text><Hint k="y" label="ship" tone={C.success} on={() => onKey('y')} /><Hint k="n" label="cancel" on={() => onKey('n')} /></box>
  return null
}

function Table({ items, selected, rowsShown, width, cols, onClick, onScroll, active, hover, onHover }: { items: Grouped[]; selected: number; rowsShown: number; width: number; cols: { project: boolean; tokens: boolean; track: boolean }; onClick: (i: number) => void; onScroll: (down: boolean) => void; active: boolean; hover: string | null; onHover: (key: string | null) => void }) {
  // the selected row shows only while the table has the cursor (one cursor on the screen)
  const bg = (on: boolean, key: string) => (on && active ? C.selected : hover === key ? C.panel : undefined)
  const stageW = cols.track ? 12 : 8, statusW = 20, nextW = width >= 120 ? 24 : 18
  const fixed = 10 + (cols.project ? 7 : 0) + 10 + stageW + statusW + 8 + (cols.tokens ? 7 : 0) + 1 + nextW
  const titleW = Math.max(12, width - fixed)
  const first = Math.max(0, Math.min(selected - rowsShown + 1, items.length - rowsShown))
  const visible = items.slice(first, first + rowsShown)
  const head = `${fit('Run', 9)} ${fit('Task', titleW)}${cols.project ? ` ${fit('Proj', 6)}` : ''} ${fit('Line', 9)}${fit('Stage', stageW)}${fit('Status', statusW)}${fitL('Time', 7)} ${cols.tokens ? `${fitL('Tokens', 6)} ` : ''} ${fit('Next', nextW)}`
  if (!items.length) return <box flexDirection="column"><text fg={C.muted}>{head}</text><text fg={C.muted}>No runs. Start one with n, or flow start &lt;project&gt; &lt;ticket&gt;</text></box>
  return (
    <box flexDirection="column" onMouseScroll={e => { const d = e.scroll?.direction; if (d === 'up' || d === 'down') onScroll(d === 'down') }}>
      <text fg={C.muted}>{head}</text>
      {visible.map((x, i) => {
        const on = first + i === selected
        if (x.kind === 'group') return (
          <box key={`g-${x.stage}`} backgroundColor={bg(on, `g:${x.stage}`)} onMouseDown={() => onClick(first + i)} onMouseOver={() => onHover(`g:${x.stage}`)} onMouseOut={() => onHover(null)}>
            <text><span fg={C.secondary}>{x.collapsed ? '▸ ' : '▾ '}</span><strong>{x.stage}</strong><span fg={C.muted}>{`  ${x.count} run${x.count === 1 ? '' : 's'} · ${x.tokens} tokens`}</span></text>
          </box>
        )
        const r = x.row
        return (
          <box key={r.run} backgroundColor={bg(on, `r:${r.run}`)} onMouseDown={() => onClick(first + i)} onMouseOver={() => onHover(`r:${r.run}`)} onMouseOut={() => onHover(null)}>
            <text>
              <span fg={on ? C.text : C.secondary}>{fit(r.ticket, 9)} </span>
              <span fg={r.tone === 'success' && !on ? C.muted : C.text}>{fit(r.title, titleW)}</span>
              {cols.project ? <span fg={C.muted}> {fit(r.project, 6)}</span> : null}
              <span fg={C.muted}> {fit(r.line, 9)}</span>
              <span fg={TONE[r.tone]}>{fit(cols.track ? r.track : r.stage, stageW)}</span>
              <span fg={TONE[r.tone]}>{fit(r.status, statusW)}</span>
              <span fg={C.secondary}>{fitL(r.elapsed, 7)} {cols.tokens ? `${fitL(r.tokens, 6)} ` : ''} </span>
              <span fg={r.mine ? C.warning : C.muted}>{fit(r.next, nextW)}</span>
            </text>
          </box>
        )
      })}
    </box>
  )
}

const segments = (used: boolean[]) => used.map((u, i) => <span key={i} fg={u ? C.accent : C.faint}>━━━━ </span>)

/** a share as a bar of n cells */
const meter = (share: number, n: number) => { const k = Math.round(Math.min(1, Math.max(0, share)) * n); return <><span fg={share >= 0.9 ? C.warning : C.accent}>{'━'.repeat(k)}</span><span fg={C.faint}>{'━'.repeat(n - k)}</span></> }

function Bottom({ bars, waiting, feed, run, width, runs, windows, now }: { bars: ReturnType<typeof resourceBars>; waiting: Snapshot['waiting']; feed: ReturnType<typeof activity>; run?: string; width: number; runs: Map<string, RunState>; windows: Windows; now: number }) {
  const left = Math.min(66, Math.floor(width * 0.55))
  // who holds a slot: the run, what it is doing and for how long (a device: which one)
  const who = (kind: string, id: string) => {
    const r = runs.get(id)
    if (!r) return id
    return kind === 'devices' && r.device ? `${r.ticket} ${r.device.platform} ${r.device.id}` : `${r.ticket} ${r.stage} ${duration(now - r.updatedAt)}`
  }
  const pct = (w?: { utilization: number }) => (w ? `${Math.round(w.utilization * 100)}%` : '–')
  return (
    <box flexDirection="row">
      <box flexDirection="column" width={left}>
        <text> </text>
        <text><strong>Resources</strong></text>
        {bars.map(b => (
          <text key={b.kind}>
            <span fg={C.muted}>{fit(b.label, 9)}</span>{segments(b.used)}<span fg={b.full ? C.warning : C.text}>{`${b.holders.length}/${b.used.length}${b.full ? ' full' : ''}  `}</span>
            <span fg={C.secondary}>{fit(b.holders.map(h => who(b.kind, h)).join(' · ') || 'free', Math.max(8, left - 9 - b.used.length * 5 - 10))}</span>
          </text>
        ))}
        {bars.length ? null : <text fg={C.muted}>no slot data</text>}
        <text><span fg={C.muted}>{fit('Waiting', 9)}</span><span fg={C.secondary}>{fit(waiting.length ? waiting.map((w, i) => `${i + 1}. ${runs.get(w.run)?.ticket ?? w.run} for ${WAITS_FOR[w.kind]} · ${duration(now - (runs.get(w.run)?.updatedAt ?? now))}`).join('  ') : 'nobody', left - 10)}</span></text>
        <text><span fg={C.muted}>{fit('Plan', 9)}5h </span>{meter(windows.fiveHour?.utilization ?? 0, 12)}<span fg={C.text}>{` ${pct(windows.fiveHour)}   `}</span><span fg={C.muted}>week </span>{meter(windows.week?.utilization ?? 0, 12)}<span fg={C.text}>{` ${pct(windows.week)}`}</span></text>
      </box>
      <box flexDirection="column" flexGrow={1}>
        <text> </text>
        <text><strong>Activity</strong><span fg={C.muted}>{run ? `  ${run}   ↵ open run` : '  select a run'}</span></text>
        {feed.length ? feed.map((e, i) => <text key={i}><span fg={C.muted}>{`${e.at}  `}</span><span fg={C.secondary}>{fit(e.stage, 7)}</span><span fg={e.actor === 'human' ? C.text : C.secondary}>{fit(e.text, width - left - 18)}</span></text>)
          : <text fg={C.muted}>{run ? 'no recent events' : ''}</text>}
      </box>
    </box>
  )
}

function ResourcesLine({ bars }: { bars: ReturnType<typeof resourceBars> }) {
  return <text>{bars.map(b => <span key={b.kind}><span fg={C.muted}>{`${b.label} `}</span><span fg={b.full ? C.warning : C.text}>{`${b.holders.length}/${b.used.length}`}</span><span fg={C.muted}>{b.waiting.length ? ` (${b.waiting.length} waiting)` : ''}{'   '}</span></span>)}</text>
}

function ProjectPicker({ choices, index, current, onPick }: { choices: { key: string; name: string; count: number }[]; index: number; current: string; onPick: (key: string) => void }) {
  return (
    <box position="absolute" top={1} left={8} width={40} flexDirection="column" border borderStyle="rounded" borderColor={C.faint} backgroundColor={C.panel} zIndex={10} paddingLeft={1} paddingRight={1}>
      {choices.map((c, i) => (
        <box key={c.key || '*'} backgroundColor={i === index ? C.selected : undefined} onMouseDown={() => onPick(c.key)}>
          <text>
            <span fg={C.accent}>{c.key === current ? '✓ ' : i === index ? '▸ ' : '  '}</span>
            {c.key ? <><strong>{fit(c.key, 6)}</strong><span fg={C.text}>{fit(c.name, 18)}</span></> : <span fg={C.secondary}>{fit('all projects', 24)}</span>}
            <span fg={C.muted}>{`${c.count} run${c.count === 1 ? '' : 's'}`}</span>
          </text>
        </box>
      ))}
      <text fg={C.faint}>↑↓ choose · ↵ pick · esc close</text>
    </box>
  )
}

/** the command palette: centred, the list following the cursor (and the wheel), typed to narrow */
function Palette({ text, found, index, width, title, onPick, onIndex }: { text: string; found: Action[]; index: number; width: number; title: string; onPick: (a: Action) => void; onIndex: (i: number) => void }) {
  const W = Math.min(84, width - 6), rows = 12
  const first = Math.max(0, Math.min(index - Math.floor(rows / 2), found.length - rows))
  return (
    <box position="absolute" top={3} left={Math.max(1, Math.floor((width - W) / 2))} width={W} flexDirection="column" border borderStyle="rounded" borderColor={C.accent} backgroundColor={C.panel} zIndex={40} paddingLeft={1} paddingRight={1}
      onMouseScroll={e => { const d = e.scroll?.direction; if (d === 'down') onIndex(Math.min(index + 1, found.length - 1)); if (d === 'up') onIndex(Math.max(index - 1, 0)) }}>
      <text><span fg={C.accent}>› </span><span fg={C.text}>{text}▏</span><span fg={C.muted}>{`   ${title} · ${found.length} result${found.length === 1 ? '' : 's'}`}</span></text>
      {first > 0 ? <text fg={C.faint}>{`  ↑ ${first} more`}</text> : null}
      {found.slice(first, first + rows).map((a, i) => (
        <box key={first + i} backgroundColor={first + i === index ? C.selected : undefined} onMouseDown={() => onPick(a)}>
          <text><span fg={first + i === index ? C.accent : C.faint}>{first + i === index ? '▸ ' : '  '}</span><span fg={first + i === index ? C.text : C.secondary}>{fit(a.label, Math.floor(W * 0.55))}</span><span fg={C.muted}>{a.hint ? fit(a.hint, W - Math.floor(W * 0.55) - 6) : ''}</span></text>
        </box>
      ))}
      {found.length > first + rows ? <text fg={C.faint}>{`  ↓ ${found.length - first - rows} more`}</text> : null}
      {found.length ? null : <text fg={C.muted}>nothing matches</text>}
      <text fg={C.faint}>↑↓ choose · ↵ run · esc close</text>
    </box>
  )
}

function QueueView({ runs, resources, now }: { runs: RunState[]; resources?: Snapshot; now: number }) {
  const waiting = resources?.waiting ?? []
  const paused = runs.filter(r => r.status === 'paused')
  const deadlines = runs.filter(r => r.needs?.kind === 'plan').sort((a, b) => (a.needs!.deadline ?? Infinity) - (b.needs!.deadline ?? Infinity))
  const name = (id: string) => { const r = runs.find(x => x.id === id); return r ? `${fit(r.ticket, 9)} ${fit(r.title, 40)}` : fit(id, 50) }
  return (
    <box flexDirection="column">
      <text><strong>Waiting for a slot</strong><span fg={C.muted}> {waiting.length}   first come, first served</span></text>
      {waiting.length ? waiting.map((w, i) => <text key={w.run + w.kind}><span fg={C.muted}>{`${i + 1}. `}</span><span fg={C.text}>{name(w.run)}</span><span fg={C.secondary}>{` for ${WAITS_FOR[w.kind]}`}</span></text>) : <text fg={C.muted}>Nobody waits.</text>}
      <text> </text>
      <text><strong>Paused for the plan limits</strong><span fg={C.muted}> {paused.length}</span></text>
      {paused.length ? paused.map(r => <text key={r.id}><span fg={C.text}>{name(r.id)}</span><span fg={C.secondary}>{r.pausedUntil ? ` resumes at ${hhmm(r.pausedUntil)}` : ' resumes by itself'}</span></text>) : <text fg={C.muted}>None.</text>}
      <text> </text>
      <text><strong>Plans waiting for you</strong><span fg={C.muted}> {deadlines.length}</span></text>
      {deadlines.length ? deadlines.map(r => <text key={r.id}><span fg={C.text}>{name(r.id)}</span><span fg={C.secondary}>{r.needs!.held ? ' held: only you decide' : r.needs!.deadline ? ` defaults at ${hhmm(r.needs!.deadline)} (in ${duration(Math.max(0, r.needs!.deadline - now))})` : ' no deadline'}</span></text>) : <text fg={C.muted}>None.</text>}
    </box>
  )
}

function MetricsView({ runs, projects }: { runs: RunState[]; projects: ProjectSummary[] }) {
  const keys = [...new Set([...projects.map(p => p.key), ...runs.map(r => r.project)])]
  const line = (label: string, rs: RunState[]) => {
    const shipped = rs.filter(r => r.pr || (r.patch && r.status === 'done')).length
    const sum = rs.reduce((n, r) => n + r.tokens, 0)
    return (
      <text key={label}>
        <span fg={C.text}>{fit(label, 10)}</span>
        <span fg={C.secondary}>{fitL(String(rs.length), 5)}{fitL(String(shipped), 9)}{fitL(String(rs.filter(r => r.status !== 'done' && !r.pr).length), 9)}{fitL(String(rs.filter(r => r.status === 'needs-you' || r.status === 'blocked' || r.status === 'failed').length), 9)}</span>
        <span fg={C.secondary}>{fitL(tokens(sum), 9)}{fitL(shipped ? tokens(sum / shipped) : '–', 12)}{fitL(String(rs.reduce((n, r) => n + r.loops.verifyRuns, 0)), 8)}{fitL(String(rs.reduce((n, r) => n + r.loops.review, 0)), 9)}{fitL(String(rs.reduce((n, r) => n + r.compactions, 0)), 12)}</span>
      </text>
    )
  }
  return (
    <box flexDirection="column">
      <text><strong>Metrics</strong><span fg={C.muted}>   all runs flow has recorded</span></text>
      <text fg={C.muted}>{`${fit('Project', 10)}${fitL('Runs', 5)}${fitL('Shipped', 9)}${fitL('Open', 9)}${fitL('Need you', 9)}${fitL('Tokens', 9)}${fitL('Per ship', 12)}${fitL('Verify', 8)}${fitL('Reviews', 9)}${fitL('Compactions', 12)}`}</text>
      {keys.map(k => line(k, runs.filter(r => r.project === k)))}
      {keys.length > 1 ? line('all', runs) : null}
      {keys.length ? null : <text fg={C.muted}>No runs yet.</text>}
    </box>
  )
}

function ProjectsView({ projects, runs, selected, onOpen }: { projects: ProjectSummary[]; runs: RunState[]; selected: number; onOpen: (i: number) => void }) {
  const sel = projects[Math.min(selected, projects.length - 1)]
  const tool = (k: string) => (k === 'jira' ? 'Jira' : k === 'github' ? 'GitHub' : 'Azure DevOps')
  return (
    <box flexDirection="column">
      <text><strong>Projects</strong><span fg={C.muted}>{`  ${projects.length}   `}</span><strong>↵</strong><span fg={C.muted}> settings</span></text>
      <text fg={C.muted}>{`   ${fit('Key', 8)}${fit('Name', 22)}${fit('Tickets', 16)}${fit('PRs', 16)}${fit('Repos', 8)}${fit('Devices', 15)}${fit('Patches', 10)}Runs`}</text>
      {projects.length ? projects.map((p, i) => (
        <box key={p.key} backgroundColor={i === selected ? C.selected : undefined} onMouseDown={() => onOpen(i)}>
          <text><span fg={C.accent}>{i === selected ? '▌  ' : '   '}</span><strong>{fit(p.key, 8)}</strong><span fg={C.text}>{fit(p.name, 22)}</span><span fg={C.secondary}>{`${fit(tool(p.tracker), 16)}${fit(tool(p.forge), 16)}${fit(String(p.repos.length), 8)}${fit(p.devices.join(', ') || '–', 15)}${fit(p.patches.length ? 'yes' : '–', 10)}${runs.filter(r => r.project === p.key).length}`}</span></text>
        </box>
      )) : <text fg={C.muted}>The service has not reported its projects.</text>}
      {sel ? (
        <box flexDirection="column">
          <text> </text>
          <text><strong>{` ${sel.key}`}</strong><span fg={C.faint}>{`  ~/.config/flow/projects/${sel.key}.json`}</span></text>
          {[
            ['Tickets', `${tool(sel.tracker)}${sel.tracker === 'azure' ? ' · any board of the organisation' : ''}`],
            ['PRs', `${tool(sel.forge)} · drafts`],
            ['Repos', sel.repos.map(r => (sel.defaults?.includes(r) ? `${r} (default)` : r)).join(' · ')],
            ['Agents', `${sel.maxParallel ?? 2} at once${sel.usage ? ` · turns stop at ${Math.round(sel.usage.fiveHour * 100)}% of 5 h, ${Math.round(sel.usage.week * 100)}% of the week` : ''}`],
            ['Sandbox', sel.sandbox ? `${sel.sandbox.enabled ? 'on' : 'off'} · ${sel.sandbox.writable} writable folders · ${sel.sandbox.domains} network domains${sel.sandbox.strict ? ' · strict' : ''}` : 'none'],
            ['Review', sel.review === false ? 'off' : 'an independent reviewer before ship'],
            ['Plan', `defaults taken after ${sel.deadlineMinutes} min; held questions wait for you`],
          ].map(([k, v]) => <text key={k}><span fg={C.muted}>{`   ${fit(k!, 10)}`}</span><span fg={C.secondary}>{v}</span></text>)}
        </box>
      ) : null}
    </box>
  )
}

/** the key line: [what it shows, the key's name (return, escape) or character; 'palette' for ^K; '' for none] */
const KEYS = {
  detail: [['esc back', 'escape'], ['a approve', 'a'], ['m message', 'm'], ['S ship', 'S'], ['p port', 'p'], ['^K commands', 'palette'], ['q quit', 'q']],
  tabs: [['1–4 tabs', ''], ['↑↓ move', ''], ['↵ settings (Projects)', 'return'], ['^K or : commands', 'palette'], ['n new', 'n'], ['q quit', 'q']],
  compact: [['⇥ focus', 'tab'], ['↵ open', 'return'], ['n new', 'n'], ['a approve', 'a'], ['m msg', 'm'], ['S ship', 'S'], ['p project', 'p'], ['^K', 'palette'], ['q quit', 'q']],
  runs: [['⇥ focus', 'tab'], ['↑↓ move', ''], ['↵ open', 'return'], ['n new', 'n'], ['a approve', 'a'], ['m message', 'm'], ['S ship', 'S'], ['p project', 'p'], ['s sort', 's'], ['g group', 'g'], ['/ filter', '/'], ['^K commands', 'palette'], ['q quit', 'q']],
} as const

function Bar({ mode, run, message, compact, tab, onKey }: { mode: Mode; run?: RunState; message: string; compact: boolean; tab: Tab; onKey: (name: string, typed: string, ctrl?: boolean) => void }) {
  if (mode.kind === 'filter') return (
    <box flexDirection="column">
      <text><span fg={C.accent}>Filter </span><span fg={C.text}>{mode.text}▏</span><span fg={C.muted}>   ↵ apply · esc cancel</span></text>
      <text fg={C.muted}>Filter by status, project or stage, or any text. Example: status:needs-you project:fso</text>
    </box>
  )
  if (mode.kind === 'message' && run) return <text><span fg={C.accent}>Message {run.ticket} </span><span fg={C.text}>{mode.text}▏</span><span fg={C.muted}>   ↵ send · esc cancel</span></text>
  const keys = mode.kind === 'detail' ? KEYS.detail : tab !== 'Runs' ? KEYS.tabs : compact ? KEYS.compact : KEYS.runs
  const press = (k: string) => (k === 'palette' ? onKey('k', '', true) : k === 'return' || k === 'escape' || k === 'tab' ? onKey(k, '') : onKey('', k))
  const gap = compact ? '  ' : '   '
  return (
    <box flexDirection="column">
      {message ? <text fg={message.startsWith('✕') ? C.danger : message.startsWith('✓') ? C.success : C.accent}>{message}</text> : null}
      <box flexDirection="row">
        {keys.map(([label, k]) => (k ? <Click key={label} on={() => press(k)}><text fg={C.muted}>{label + gap}</text></Click> : <text key={label} fg={C.muted}>{label + gap}</text>))}
      </box>
    </box>
  )
}
