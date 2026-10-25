import { useKeyboard, useTerminalDimensions } from '@opentui/react'
import { useEffect, useState } from 'react'
import type { RunEvent, RunState } from '../run.ts'
import type { RunFile } from '../server.ts'
import type { Command, ProjectSummary, Reply } from '../service.ts'
import type { Windows } from '../usage.ts'
import { WAITS_FOR, type Snapshot } from '../resources.ts'
import {
  activity, attention, duration, filterRuns, footer, groupRows, header, hhmm, lastMessage, layout, match, resourceBars, rows, SORTS, tokens,
  type AttentionItem, type Grouped, type Row, type Sort,
} from './model.ts'

/** What the screen needs from the service connection (FlowClient implements it). */
export interface FlowApi {
  runs: Map<string, RunState>
  windows: Windows
  resources?: Snapshot
  /** the latest events of all runs, oldest first */
  recent?: RunEvent[]
  projects?: ProjectSummary[]
  connected?: boolean
  listen(fn: (m: { type: string; notice?: { run: string; text: string } }) => void): () => void
  send(c: Command): Promise<Reply>
  events(run: string): Promise<RunEvent[]>
  file(run: string, name: RunFile): Promise<string>
}

// colour only for state (the design's tokens); the terminal's own background shows through
const C = { text: '#DDE2E8', secondary: '#A3ABB5', muted: '#6D7681', faint: '#434A54', accent: '#78A6EC', success: '#72C08A', warning: '#E2B35F', danger: '#EC7A70', selected: '#1B2533', panel: '#11161D' }
const TONE = { accent: C.accent, warning: C.warning, danger: C.danger, success: C.success, muted: C.muted }

const fit = (s: string, n: number) => (n <= 0 ? '' : s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n))
const fitL = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s.padStart(n))

const TABS = ['Runs', 'Queue', 'Resources', 'Activity', 'Metrics', 'Projects'] as const
type Tab = (typeof TABS)[number]

type Mode =
  | { kind: 'list' }
  | { kind: 'approve'; run: string; editing: boolean; text: string }
  | { kind: 'ship'; run: string }
  | { kind: 'message'; run: string; text: string }
  | { kind: 'new'; text: string }
  | { kind: 'detail'; run: string }
  | { kind: 'filter'; text: string }
  | { kind: 'palette'; text: string; index: number }

interface Detail { events: RunEvent[]; plan: string; pr: string; review: string }

/** an entry of the command palette: what it says, and what choosing it does */
interface Action { label: string; hint?: string; run: () => void }

const NEW_HELP = '<project> <ticket> [base] [repos=a,b] [device=android|ios] [patch=customer/app]'

export function App({ api, now = Date.now, onQuit = () => process.exit(0) }: { api: FlowApi; now?: () => number; onQuit?: () => void }) {
  const [, setTick] = useState(0)
  const [selected, setSelected] = useState(0)
  const [mode, setMode] = useState<Mode>({ kind: 'list' })
  const [notice, setNotice] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [tab, setTab] = useState<Tab>('Runs')
  const [sort, setSort] = useState<Sort>('newest')
  const [grouped, setGrouped] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
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
  const state = current ? api.runs.get(current.run) : undefined
  const recent = api.recent ?? []

  const detailRun = mode.kind === 'detail' ? mode.run : null
  useEffect(() => {
    if (!detailRun) { setDetail(null); return }
    let live = true
    void Promise.all([api.events(detailRun), api.file(detailRun, 'plan.md'), api.file(detailRun, 'pr.md'), api.file(detailRun, 'review.json')])
      .then(([events, plan, pr, review]) => { if (live) setDetail({ events, plan, pr, review }) })
    return () => { live = false }
  }, [detailRun, api, api.runs.get(detailRun ?? '')?.updatedAt])

  const send = async (c: Command, done: string) => {
    const r = await api.send(c)
    setNotice(r.ok ? done : r.error)
    setMode(m => (m.kind === 'detail' ? m : { kind: 'list' }))
  }

  // what a key (or the palette) does to a run
  const ask = {
    approve: (r: RunState) => (r.needs?.kind === 'plan' ? setMode({ kind: 'approve', run: r.id, editing: false, text: '' }) : setNotice(`${r.ticket}: no plan is waiting for you`)),
    ship: (r: RunState) => (r.needs?.kind === 'ship' || (r.needs?.kind === 'patch' && r.patch) ? setMode({ kind: 'ship', run: r.id }) : setNotice(`${r.ticket} is not ready to ship`)),
    message: (r: RunState) => setMode({ kind: 'message', run: r.id, text: '' }),
    port: (r: RunState) => (r.pr ? void send({ cmd: 'port', run: r.id }, `porting ${r.ticket} to develop`) : setNotice(`${r.ticket} has no draft PR to port yet`)),
    release: (r: RunState) => (r.device ? void send({ cmd: 'release', run: r.id }, `stopping ${r.ticket}'s device`) : setNotice(`${r.ticket} has no device`)),
    open: (r: RunState) => setMode({ kind: 'detail', run: r.id }),
  }
  const goTab = (x: Tab) => { setTab(x); setMode({ kind: 'list' }) }

  const actions = (): Action[] => {
    const a: Action[] = []
    if (state) {
      a.push({ label: `Open ${state.ticket}`, hint: state.title, run: () => ask.open(state) })
      if (state.needs?.kind === 'plan') a.push({ label: `Approve plan of ${state.ticket}`, hint: 'with the defaults, or other answers', run: () => ask.approve(state) })
      a.push({ label: `Message ${state.ticket}'s agent`, run: () => ask.message(state) })
      if (state.needs?.kind === 'ship' || state.needs?.kind === 'patch') a.push({ label: state.patch ? (state.needs.kind === 'patch' ? `Write the patch back for ${state.ticket}` : `Check the write-back of ${state.ticket}`) : `Ship ${state.ticket}`, hint: state.patch ? undefined : 'commit, push, draft PR', run: () => ask.ship(state) })
      if (state.pr) a.push({ label: `Port ${state.ticket} to develop`, run: () => ask.port(state) })
      if (state.device) a.push({ label: `Stop ${state.ticket}'s device`, hint: `${state.device.platform} ${state.device.id}`, run: () => ask.release(state) })
    }
    a.push({ label: 'New run', hint: NEW_HELP, run: () => setMode({ kind: 'new', text: '' }) })
    a.push({ label: 'Show runs that need you', hint: 'status:needs-you', run: () => { setFilter('status:needs-you'); goTab('Runs') } })
    a.push({ label: 'Show failed and blocked runs', hint: 'status:failed', run: () => { setFilter('status:failed'); goTab('Runs') } })
    for (const p of api.projects ?? []) a.push({ label: `Show ${p.name} runs`, hint: `project:${p.key}`, run: () => { setFilter(`project:${p.key}`); goTab('Runs') } })
    if (filter) a.push({ label: 'Clear the filter', hint: filter, run: () => { setFilter(''); setMode({ kind: 'list' }) } })
    a.push({ label: grouped ? 'Stop grouping' : 'Group by stage', run: () => { setGrouped(g => !g); setMode({ kind: 'list' }) } })
    for (const x of SORTS) if (x !== sort) a.push({ label: `Sort by ${x}`, run: () => { setSort(x); setMode({ kind: 'list' }) } })
    for (const x of TABS) if (x !== tab) a.push({ label: `Go to ${x}`, hint: String(TABS.indexOf(x) + 1), run: () => goTab(x) })
    a.push({ label: 'Quit', hint: 'q', run: onQuit })
    return a
  }
  const found = mode.kind === 'palette' ? actions().filter(x => match(mode.text, x.label)) : []

  useKeyboard(key => {
    const name = key.name, typed = key.sequence && key.sequence.length === 1 && key.sequence >= ' ' ? key.sequence : ''
    // typing goes through the latest state: keys can arrive faster than the screen redraws
    const edit = (f: (text: string) => string) => setMode(prev => ('text' in prev ? ({ ...prev, text: f(prev.text), ...(prev.kind === 'palette' ? { index: 0 } : {}) } as Mode) : prev))
    const input = (m: Extract<Mode, { text: string }>, enter: (text: string) => void) => {
      if (name === 'escape') return setMode({ kind: 'list' })
      if (name === 'backspace') return edit(x => x.slice(0, -1))
      if (name === 'return') return enter(m.text)
      if (typed) edit(x => x + typed)
    }
    if (mode.kind === 'palette') {
      if (name === 'down' || (key.ctrl && name === 'n')) return setMode({ ...mode, index: Math.min(mode.index + 1, Math.max(0, found.length - 1)) })
      if (name === 'up' || (key.ctrl && name === 'p')) return setMode({ ...mode, index: Math.max(mode.index - 1, 0) })
      if (name === 'return') { const a = found[mode.index]; setMode({ kind: 'list' }); a?.run(); return }
      if (name === 'backspace') return edit(x => x.slice(0, -1))
      if (name === 'escape') return setMode({ kind: 'list' })
      if (typed) edit(x => x + typed)
      return
    }
    if (mode.kind === 'filter') return input(mode, text => { setFilter(text.trim()); setSelected(0); setMode({ kind: 'list' }) })
    if (mode.kind === 'new') return input(mode, text => {
      const [project, ticket, ...rest] = text.trim().split(/\s+/)
      if (!project || !ticket) return setNotice(`type: ${NEW_HELP}`)
      const repos = rest.find(x => x.startsWith('repos='))?.slice(6).split(',').filter(Boolean)
      const device = rest.find(x => x.startsWith('device='))?.slice(7)
      if (device && device !== 'android' && device !== 'ios') return setNotice('device is android or ios')
      const patch = rest.find(x => x.startsWith('patch='))?.slice(6)
      const base = rest.find(x => !x.includes('='))
      void send({ cmd: 'start', project, ticket: /^\d+$/.test(ticket) ? Number(ticket) : ticket, ...(base ? { base } : {}), ...(repos?.length ? { repos } : {}), ...(device ? { device: device as 'android' | 'ios' } : {}), ...(patch ? { patch } : {}) }, `starting ${project}-${ticket}`)
    })
    if (mode.kind === 'message') return input(mode, text => { if (text.trim()) void send({ cmd: 'message', run: mode.run, text: text.trim() }, `message sent to ${mode.run}`) })
    if (mode.kind === 'approve' && mode.editing) return input(mode, text => {
      if (!text.trim()) return
      const answers = Object.fromEntries(text.trim().split(/\s+/).map(p => p.split('=')).filter(p => p.length === 2 && p[1]).map(([k, v]) => [k!.toUpperCase(), v!]))
      void send({ cmd: 'approve', run: mode.run, answers }, `plan approved: ${mode.run}`)
    })
    if (mode.kind === 'approve') {
      if (typed === 'y') return void send({ cmd: 'approve', run: mode.run }, `plan approved with the defaults: ${mode.run}`)
      if (typed === 'e') return setMode({ ...mode, editing: true, text: '' })
      if (typed === 'n' || name === 'escape') return setMode({ kind: 'list' })
      return
    }
    if (mode.kind === 'ship') {
      if (typed === 'y') {
        const r = api.runs.get(mode.run)
        const what = !r?.patch ? 'commit, push, draft PR' : r.needs?.kind === 'patch' ? 'writing the patch back' : 'write-back dry run'
        return void send({ cmd: 'ship', run: mode.run }, `shipping ${mode.run}: ${what}`)
      }
      if (typed === 'n' || name === 'escape') return setMode({ kind: 'list' })
      return
    }
    if ((key.ctrl && name === 'k') || typed === ':') return setMode({ kind: 'palette', text: '', index: 0 })
    if (name === 'escape' && mode.kind === 'detail') return setMode({ kind: 'list' })
    if (name === 'escape' && filter) { setFilter(''); return }
    if (typed === 'q') return onQuit()
    if (typed >= '1' && typed <= '6') return goTab(TABS[Number(typed) - 1]!)
    if (typed === 'n') return setMode({ kind: 'new', text: '' })
    if (tab !== 'Runs' && mode.kind !== 'detail') return
    if (name === 'down' || typed === 'j') return setSelected(Math.min(sel + 1, items.length - 1))
    if (name === 'up' || typed === 'k') return setSelected(Math.max(sel - 1, 0))
    if (typed === 's') return setSort(SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length]!)
    if (typed === 'g') { setGrouped(g => !g); setSelected(0); return }
    if (typed === '/') return setMode({ kind: 'filter', text: filter })
    if (name === 'return' && item?.kind === 'group') { const next = new Set(collapsed); next.has(item.stage) ? next.delete(item.stage) : next.add(item.stage); setCollapsed(next); return }
    if (!state) return
    if (name === 'return') return ask.open(state)
    if (typed === 'a') return ask.approve(state)
    if (typed === 'S') return ask.ship(state)
    if (typed === 'm') return ask.message(state)
    if (typed === 'p') return ask.port(state)
  })

  if (L.tooSmall) return <box paddingLeft={1}><text fg={C.warning}>{L.text}</text></box>

  const bars = api.resources ? resourceBars(api.resources) : []
  const inline = mode.kind === 'approve' || mode.kind === 'ship' ? mode.run : undefined
  const message = notice ?? (L.message ? lastMessage(recent, t) : '')
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Tabs tab={tab} names={L.tabNames} filter={filter} connected={api.connected !== false} />
      <text>
        <span fg={C.accent}>● </span><span fg={C.text}>{h.active}</span><span fg={C.muted}> active   </span>
        <span fg={C.warning}>▲ </span><span fg={C.text}>{h.needYou}</span><span fg={C.muted}> need you   </span>
        <span fg={C.secondary}>◌ </span><span fg={C.text}>{h.waiting}</span><span fg={C.muted}> waiting   </span>
        {bars.filter(b => b.kind !== 'agents').map(b => <span key={b.kind} fg={b.full ? C.warning : C.muted}>{`${b.label.toLowerCase()} `}<span fg={C.text}>{`${b.holders.length}/${b.used.length}`}</span>{'   '}</span>)}
        <span fg={C.muted}>5h </span><span fg={C.text}>{h.fiveHour}</span><span fg={C.muted}>{h.fiveHourReset && L.tabNames ? ` (resets ${h.fiveHourReset})` : ''}   week </span><span fg={C.text}>{h.week}</span>
      </text>
      <text> </text>
      {mode.kind === 'detail' && api.runs.get(mode.run) ? <DetailView run={api.runs.get(mode.run)!} detail={detail} now={t} />
        : tab === 'Runs' ? (
          <>
            <Attention items={att} shown={L.attentionShown} two={L.twoLineAttention} inline={inline} mode={mode} runs={api.runs} resources={api.resources} />
            <text> </text>
            <text>
              <strong>Runs</strong><span fg={C.muted}> {filter ? `${shown.length} of ${all.length}` : shown.length}   </span>
              <strong>s</strong><span fg={C.muted}> sort </span><span fg={C.secondary}>{sort}   </span>
              <strong>g</strong><span fg={C.muted}> group </span><span fg={C.secondary}>{grouped ? 'stage' : 'none'}   </span>
              <strong>/</strong><span fg={C.muted}> filter </span><span fg={filter ? C.accent : C.secondary}>{filter || 'none'}</span>
            </text>
            <Table items={items} selected={sel} rowsShown={L.tableRows} width={width - 2} cols={{ project: L.project, tokens: L.tokens, track: L.track }} />
            <text fg={C.muted}>{list.length ? footer(all, shown, filter, t) : ''}</text>
            {L.bottom ? (L.split
              ? <Bottom bars={bars} waiting={api.resources?.waiting ?? []} feed={state ? activity(recent, state.id).slice(0, 5) : []} run={state?.ticket} width={width - 2} />
              : <><text> </text><ResourcesLine bars={bars} /></>) : null}
          </>
        ) : tab === 'Queue' ? <QueueView runs={all} resources={api.resources} now={t} />
        : tab === 'Resources' ? <ResourcesView bars={bars} windows={api.windows} runs={api.runs} now={t} />
        : tab === 'Activity' ? <ActivityView recent={recent} rowsShown={height - 9} />
        : tab === 'Metrics' ? <MetricsView runs={all} projects={api.projects ?? []} />
        : <ProjectsView projects={api.projects ?? []} runs={all} />}
      <text> </text>
      {mode.kind === 'palette' ? <Palette text={mode.text} found={found} index={mode.index} /> : null}
      <Bar mode={mode} run={mode.kind === 'message' ? api.runs.get(mode.run) : undefined} message={message} compact={!L.tabNames} tab={tab} />
    </box>
  )
}

function Tabs({ tab, names, filter, connected }: { tab: Tab; names: boolean; filter: string; connected: boolean }) {
  const project = /project:(\S+)/.exec(filter)?.[1]
  return (
    <text>
      <span fg={C.accent}>∿ </span><strong>flow</strong><span fg={C.muted}>  {project ?? 'all projects'}   </span>
      {TABS.map((x, i) => (x === tab
        ? <span key={x}><strong>{`${i + 1} ${x}`}</strong>{'  '}</span>
        : <span key={x} fg={C.muted}>{names ? `${i + 1} ${x}  ` : `${i + 1}  `}</span>))}
      <span fg={connected ? C.success : C.danger}>{'  ● '}</span><span fg={C.muted}>{connected ? 'connected' : 'disconnected'}</span>
    </text>
  )
}

function Attention({ items, shown, two, inline, mode, runs, resources }: { items: AttentionItem[]; shown: number; two: boolean; inline?: string; mode: Mode; runs: Map<string, RunState>; resources?: Snapshot }) {
  return (
    <box flexDirection="column">
      <text><strong>Needs attention</strong><span fg={C.warning}> {items.length}</span>{items.length ? <span fg={C.faint}>   held first, then by deadline</span> : null}</text>
      {items.length ? items.slice(0, Math.max(shown, inline ? items.findIndex(a => a.run === inline) + 1 : 0)).map(a => (
        <box key={a.run} flexDirection="column">
          <text>
            <span fg={C.secondary}>{fit(a.ticket, 9)}</span> <strong>{fit(a.title, two ? 34 : 26)}</strong> {two ? <span fg={C.muted}>{fit(a.line, 9)}</span> : null}
            <span fg={TONE[a.tone]}> ◆ {fit(a.label, 15)}</span><span fg={C.secondary}>{fit(a.when, 18)}</span>
            <strong>{a.key}</strong><span fg={C.secondary}> {a.action}</span>
          </text>
          {two ? <text fg={C.muted}>{`          ${a.detail.slice(0, 110)}`}</text> : null}
          {inline === a.run ? <Confirm mode={mode} run={runs.get(a.run)} resources={resources} /> : null}
        </box>
      )) : <text fg={C.muted}>Nothing needs you.</text>}
      {items.length > Math.max(shown, 1) && !inline ? <text fg={C.faint}>{`          and ${items.length - shown} more below`}</text> : null}
    </box>
  )
}

/** the confirm under the item it acts on: what happens, and what it will wait for */
function Confirm({ mode, run, resources }: { mode: Mode; run?: RunState; resources?: Snapshot }) {
  if (!run) return null
  const builds = resources ? resources.holders.builds.length >= resources.limits.builds : false
  const queue = builds ? ` Builds are full, so ${run.ticket} waits for a build slot${resources!.waiting.length ? ` (${resources!.waiting.length} waiting)` : ''}.` : ''
  if (mode.kind === 'approve' && mode.editing) return <text>{'          '}<span fg={C.warning}>Answers </span><span fg={C.text}>{mode.text}▏</span><span fg={C.muted}>   e.g. Q1=yes Q2=no · ↵ approve · esc cancel</span></text>
  if (mode.kind === 'approve') return (
    <box flexDirection="column">
      <text>{'          '}<strong>{`Approve ${run.ticket} with the defaults and start the build?`}</strong><span fg={C.secondary}>{queue}</span></text>
      {(run.plan?.questions ?? []).map(q => <text key={q.id} fg={C.secondary}>{`            ${q.id}${q.held ? ' (held)' : ''} ${q.text} → ${q.default}`}</text>)}
      <text>{'          '}<strong>y</strong><span fg={C.warning}> approve</span><span fg={C.muted}>   </span><strong>e</strong><span fg={C.secondary}> other answers</span><span fg={C.muted}>   </span><strong>n</strong><span fg={C.secondary}> cancel</span></text>
    </box>
  )
  if (mode.kind === 'ship' && run.patch) {
    const real = run.needs?.kind === 'patch'
    return <text>{'          '}<strong>{real ? `Write the patch back for ${run.ticket}?` : `Check the write-back for ${run.ticket}?`}</strong><span fg={C.secondary}>{real ? ' the patch and the fix, as the dry run showed   ' : ' a dry run, nothing written   '}</span><strong>y</strong><span fg={C.success}> {real ? 'write back' : 'check'}</span><span fg={C.muted}>   </span><strong>n</strong><span fg={C.secondary}> cancel</span></text>
  }
  if (mode.kind === 'ship') return <text>{'          '}<strong>{`Ship ${run.ticket}?`}</strong><span fg={C.secondary}> commit, push, open a draft PR   </span><strong>y</strong><span fg={C.success}> ship</span><span fg={C.muted}>   </span><strong>n</strong><span fg={C.secondary}> cancel</span></text>
  return null
}

function Table({ items, selected, rowsShown, width, cols }: { items: Grouped[]; selected: number; rowsShown: number; width: number; cols: { project: boolean; tokens: boolean; track: boolean } }) {
  const stageW = cols.track ? 12 : 8, statusW = 20, nextW = width >= 120 ? 24 : 18
  const fixed = 10 + (cols.project ? 7 : 0) + 10 + stageW + statusW + 7 + (cols.tokens ? 7 : 0) + 1 + nextW
  const titleW = Math.max(12, width - fixed)
  const first = Math.max(0, Math.min(selected - rowsShown + 1, items.length - rowsShown))
  const visible = items.slice(first, first + rowsShown)
  const head = `${fit('Run', 9)} ${fit('Task', titleW)}${cols.project ? ` ${fit('Proj', 6)}` : ''} ${fit('Line', 9)}${fit('Stage', stageW)}${fit('Status', statusW)}${fitL('Time', 6)} ${cols.tokens ? `${fitL('Tokens', 6)} ` : ''} ${fit('Next', nextW)}`
  if (!items.length) return <box flexDirection="column"><text fg={C.muted}>{head}</text><text fg={C.muted}>No runs. Start one with n, or flow start &lt;project&gt; &lt;ticket&gt;</text></box>
  return (
    <box flexDirection="column">
      <text fg={C.muted}>{head}</text>
      {visible.map((x, i) => {
        const on = first + i === selected
        if (x.kind === 'group') return (
          <box key={`g-${x.stage}`} backgroundColor={on ? C.selected : undefined}>
            <text><span fg={C.secondary}>{x.collapsed ? '▸ ' : '▾ '}</span><strong>{x.stage}</strong><span fg={C.muted}>{`  ${x.count} run${x.count === 1 ? '' : 's'} · ${x.tokens} tokens`}</span></text>
          </box>
        )
        const r = x.row
        return (
          <box key={r.run} backgroundColor={on ? C.selected : undefined}>
            <text>
              <span fg={on ? C.text : C.secondary}>{fit(r.ticket, 9)} </span>
              <span fg={r.tone === 'success' && !on ? C.muted : C.text}>{fit(r.title, titleW)}</span>
              {cols.project ? <span fg={C.muted}> {fit(r.project, 6)}</span> : null}
              <span fg={C.muted}> {fit(r.line, 9)}</span>
              <span fg={TONE[r.tone]}>{fit(cols.track ? r.track : r.stage, stageW)}</span>
              <span fg={TONE[r.tone]}>{fit(r.status, statusW)}</span>
              <span fg={C.secondary}>{fitL(r.elapsed, 6)} {cols.tokens ? `${fitL(r.tokens, 6)} ` : ''} </span>
              <span fg={r.mine ? C.warning : C.muted}>{fit(r.next, nextW)}</span>
            </text>
          </box>
        )
      })}
    </box>
  )
}

const segments = (used: boolean[]) => used.map((u, i) => <span key={i} fg={u ? C.accent : C.faint}>━━━━ </span>)

function Bottom({ bars, waiting, feed, run, width }: { bars: ReturnType<typeof resourceBars>; waiting: Snapshot['waiting']; feed: ReturnType<typeof activity>; run?: string; width: number }) {
  const left = Math.min(56, Math.floor(width / 2))
  return (
    <box flexDirection="row">
      <box flexDirection="column" width={left}>
        <text> </text>
        <text><strong>Resources</strong></text>
        {bars.map(b => (
          <text key={b.kind}><span fg={C.muted}>{fit(b.label, 9)}</span>{segments(b.used)}<span fg={b.full ? C.warning : C.secondary}>{b.text}</span></text>
        ))}
        {bars.length ? <text fg={C.secondary}>{fit(bars.flatMap(b => b.holders.map(x => `${x} ${b.kind === 'agents' ? 'agent' : b.kind === 'builds' ? 'building' : 'device'}`)).join(' · ') || 'nothing held', left - 1)}</text> : <text fg={C.muted}>no slot data</text>}
        <text fg={C.secondary}>{fit(waiting.length ? `Waiting  ${waiting.map(w => `${w.run} for ${WAITS_FOR[w.kind]}`).join(' · ')}` : 'Waiting  nobody', left - 1)}</text>
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

function Palette({ text, found, index }: { text: string; found: Action[]; index: number }) {
  return (
    <box position="absolute" top={5} left={10} width={70} flexDirection="column" border borderStyle="rounded" borderColor={C.accent} backgroundColor={C.panel} zIndex={10} paddingLeft={1} paddingRight={1}>
      <text><span fg={C.accent}>› </span><span fg={C.text}>{text}▏</span><span fg={C.muted}>{`   ${found.length} result${found.length === 1 ? '' : 's'}`}</span></text>
      {found.slice(0, 10).map((a, i) => (
        <box key={a.label} backgroundColor={i === index ? C.selected : undefined}>
          <text><span fg={i === index ? C.text : C.secondary}>{fit(a.label, 34)}</span><span fg={C.muted}>{a.hint ? fit(a.hint, 30) : ''}</span></text>
        </box>
      ))}
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

function ResourcesView({ bars, windows, runs, now }: { bars: ReturnType<typeof resourceBars>; windows: Windows; runs: Map<string, RunState>; now: number }) {
  const who = (id: string) => { const r = runs.get(id); return r ? `${r.ticket} ${r.stage}` : id }
  const win = (label: string, w?: { utilization: number; resetsAt: number }) => (
    <text key={label}><span fg={C.muted}>{fit(label, 9)}</span>{w ? <><span fg={w.utilization >= 0.9 ? C.warning : C.text}>{fitL(`${Math.round(w.utilization * 100)}%`, 4)}</span><span fg={C.muted}>{w.resetsAt * 1000 > now ? `  resets ${hhmm(w.resetsAt * 1000)}` : ''}</span></> : <span fg={C.muted}>not reported yet</span>}</text>
  )
  return (
    <box flexDirection="column">
      <text><strong>Slots</strong><span fg={C.muted}>   shared by every run on this machine · limits in ~/.config/flow/flow.json</span></text>
      {bars.length ? bars.map(b => (
        <box key={b.kind} flexDirection="column">
          <text><span fg={C.muted}>{fit(b.label, 9)}</span>{segments(b.used)}<span fg={b.full ? C.warning : C.secondary}>{b.text}</span></text>
          <text fg={C.secondary}>{`         ${b.holders.length ? b.holders.map(who).join(' · ') : 'free'}${b.waiting.length ? `   waiting: ${b.waiting.map(who).join(' · ')}` : ''}`}</text>
        </box>
      )) : <text fg={C.muted}>The service has not reported its slots.</text>}
      <text> </text>
      <text><strong>Plan windows</strong><span fg={C.muted}>   turns start only under 90% (5 hours) and 95% (week)</span></text>
      {win('5 hours', windows.fiveHour)}
      {win('Week', windows.week)}
    </box>
  )
}

function ActivityView({ recent, rowsShown }: { recent: RunEvent[]; rowsShown: number }) {
  const feed = activity(recent).slice(0, Math.max(5, rowsShown))
  return (
    <box flexDirection="column">
      <text><strong>Activity</strong><span fg={C.muted}>   every run, newest first</span></text>
      {feed.length ? feed.map((e, i) => <text key={i}><span fg={C.muted}>{`${e.at}  `}</span><span fg={C.secondary}>{fit(e.run, 22)}</span><span fg={C.muted}>{fit(e.actor, 7)}</span><span fg={C.secondary}>{fit(e.stage, 7)}</span><span fg={e.actor === 'human' ? C.text : C.secondary}>{e.text.slice(0, 80)}</span></text>)
        : <text fg={C.muted}>Nothing has happened yet.</text>}
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

function ProjectsView({ projects, runs }: { projects: ProjectSummary[]; runs: RunState[] }) {
  return (
    <box flexDirection="column">
      <text><strong>Projects</strong><span fg={C.muted}>   from ~/.config/flow/projects/&lt;key&gt;.json</span></text>
      {projects.length ? projects.map(p => (
        <box key={p.key} flexDirection="column">
          <text><strong>{fit(p.key, 8)}</strong><span fg={C.text}>{fit(p.name, 24)}</span><span fg={C.secondary}>{`tickets ${p.tracker === 'jira' ? 'Jira' : 'Azure DevOps'} · PRs ${p.forge === 'github' ? 'GitHub' : 'Azure DevOps'} · ${runs.filter(r => r.project === p.key).length} runs`}</span></text>
          <text fg={C.muted}>{`        repos ${p.repos.join(', ')}${p.devices.length ? ` · devices ${p.devices.join(', ')}` : ''}${p.patches.length ? ` · customer patches in ${p.patches.join(', ')}` : ''} · plan defaults after ${p.deadlineMinutes} min`}</text>
        </box>
      )) : <text fg={C.muted}>The service has not reported its projects.</text>}
    </box>
  )
}

const eventLine = (e: RunEvent) => {
  const d = e.type === 'verify.result' ? (e.ok ? 'no new findings' : `${e.newFindings.length} new`) : e.type === 'plan.submitted' ? `${e.questions.length} question(s)`
    : e.type === 'plan.decided' ? `by ${e.by}` : e.type === 'tokens.used' ? tokens(e.tokens) : e.type === 'run.blocked' || e.type === 'setup.failed' ? e.reason
    : e.type === 'tool.denied' ? `${e.tool}: ${e.detail}` : e.type === 'pr.opened' ? e.url : e.type === 'human.message' ? e.text : e.type === 'run.paused' ? `until ${hhmm(e.until)}` : e.type === 'device.ready' ? `${e.platform} ${e.id} :${e.metroPort}` : ''
  return `${hhmm(e.at)}  ${e.actor.padEnd(6)} ${e.type}${d ? `  ${d}` : ''}`
}

function DetailView({ run, detail, now }: { run: RunState; detail: Detail | null; now: number }) {
  const summary = detail?.plan.replace(/^#.*\n/, '').trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ') ?? ''
  const lastVerify = [...(detail?.events ?? [])].reverse().find(e => e.type === 'verify.result')
  const timeline = (detail?.events ?? []).filter(e => e.type !== 'tokens.used').slice(-14)
  return (
    <box flexDirection="column">
      <text><span fg={C.secondary}>{run.ticket} </span><strong>{run.title}</strong><span fg={C.muted}>   {run.project} · from {run.base} · {duration(now - run.createdAt)} · {tokens(run.tokens)} tokens · {run.compactions} compactions</span></text>
      <text fg={C.warning}>{run.needs ? `Needs you: ${run.needs.ask}` : `${run.stage} · ${run.status}`}</text>
      {run.patch ? <text fg={C.secondary}>{`Customer patch ${run.patch.customer}/${run.patch.app} (applied locally, written back at ship)`}</text> : null}
      {run.device ? <text fg={C.secondary}>{`Device ${run.device.platform} ${run.device.id} · Metro :${run.device.metroPort}`}</text> : null}
      <text> </text>
      <text><strong>Plan</strong></text>
      <text fg={C.secondary}>{summary ? (summary.length > 300 ? `${summary.slice(0, 300).replace(/\s+\S*$/, '')}…` : summary) : detail ? 'no plan yet' : 'loading…'}</text>
      {(run.plan?.questions ?? []).map(q => (
        <text key={q.id}><span fg={C.secondary}>  {q.id}{q.held ? ' (held)' : ''} {q.text} </span><span fg={C.text}>→ {run.plan?.answers?.[q.id] ?? `default: ${q.default}`}</span></text>
      ))}
      {lastVerify && lastVerify.type === 'verify.result' && !lastVerify.ok ? (
        <>
          <text> </text>
          <text><strong>New findings</strong><span fg={C.danger}> {lastVerify.newFindings.length}</span></text>
          {lastVerify.newFindings.slice(0, 6).map(f => <text key={f} fg={C.danger}>{`  ${f.slice(0, 110)}`}</text>)}
        </>
      ) : null}
      <ReviewView json={detail?.review ?? ''} />
      {run.pr ? <text><span fg={C.success}>Draft PR #{run.pr.number} </span><span fg={C.secondary}>{run.pr.url}</span></text> : null}
      <text> </text>
      <text><strong>Timeline</strong></text>
      {timeline.map(e => <text key={e.seq} fg={e.actor === 'human' ? C.text : C.secondary}>{`  ${eventLine(e).slice(0, 120)}`}</text>)}
    </box>
  )
}

function ReviewView({ json }: { json: string }) {
  if (!json.trim()) return null
  let r: { review: number; findings: { severity: string; file: string; line?: number; problem: string }[]; dropped: number; below?: { severity: string; file: string; line?: number; problem: string; confidence: number }[] }
  try { r = JSON.parse(json) } catch { return null }
  return (
    <>
      <text> </text>
      <text><strong>Review {r.review}</strong><span fg={r.findings.length ? C.warning : C.success}> {r.findings.length ? `${r.findings.length} finding(s)` : 'nothing found'}</span>{r.dropped ? <span fg={C.muted}> · {r.dropped} below 80% confidence left out</span> : null}</text>
      {r.findings.slice(0, 6).map((f, i) => <text key={i} fg={C.secondary}>{`  R${i + 1} [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''}  ${f.problem}`.slice(0, 120)}</text>)}
      {(r.below ?? []).slice(0, 4).map((f, i) => <text key={`b${i}`} fg={C.muted}>{`  ${f.confidence}%  [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''}  ${f.problem}`.slice(0, 120)}</text>)}
    </>
  )
}

function Bar({ mode, run, message, compact, tab }: { mode: Mode; run?: RunState; message: string; compact: boolean; tab: Tab }) {
  if (mode.kind === 'new') return (
    <box flexDirection="column">
      {message ? <text fg={C.accent}>{message}</text> : null}
      <text><span fg={C.accent}>New run </span><span fg={C.text}>{mode.text}▏</span><span fg={C.muted}>   {NEW_HELP} · ↵ start · esc cancel</span></text>
    </box>
  )
  if (mode.kind === 'filter') return (
    <box flexDirection="column">
      <text><span fg={C.accent}>Filter </span><span fg={C.text}>{mode.text}▏</span><span fg={C.muted}>   ↵ apply · esc cancel</span></text>
      <text fg={C.muted}>Filter by status, project or stage, or any text. Example: status:needs-you project:fso</text>
    </box>
  )
  if (mode.kind === 'message' && run) return <text><span fg={C.accent}>Message {run.ticket} </span><span fg={C.text}>{mode.text}▏</span><span fg={C.muted}>   ↵ send · esc cancel</span></text>
  const keys = mode.kind === 'detail' ? 'esc back   a approve   m message   S ship   p port   ^K commands   q quit'
    : tab !== 'Runs' ? '1–6 tabs   ^K or : commands   n new   q quit'
    : compact ? '↑↓ move  ↵ open  n new  a approve  m msg  S ship  ^K cmds  q quit'
    : '↑↓/jk move   ↵ open   n new   a approve   m message   S ship   p port   s sort   g group   / filter   ^K commands   q quit'
  return (
    <box flexDirection="column">
      {message ? <text fg={message.startsWith('✕') ? C.danger : message.startsWith('✓') ? C.success : C.accent}>{message}</text> : null}
      <text fg={C.muted}>{keys}</text>
    </box>
  )
}
