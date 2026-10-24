import { useKeyboard, useTerminalDimensions } from '@opentui/react'
import { useEffect, useState } from 'react'
import type { RunEvent, RunState } from '../run.ts'
import type { RunFile } from '../server.ts'
import type { Command, Reply } from '../service.ts'
import type { Windows } from '../usage.ts'
import { attention, duration, header, hhmm, rows, tokens, type AttentionItem, type Row } from './model.ts'

/** What the screen needs from the service connection (FlowClient implements it). */
export interface FlowApi {
  runs: Map<string, RunState>
  windows: Windows
  listen(fn: (m: { type: string; notice?: { run: string; text: string } }) => void): () => void
  send(c: Command): Promise<Reply>
  events(run: string): Promise<RunEvent[]>
  file(run: string, name: RunFile): Promise<string>
}

// colour only for state (the design's tokens); the terminal's own background shows through
const C = { text: '#DDE2E8', secondary: '#A3ABB5', muted: '#6D7681', faint: '#434A54', accent: '#78A6EC', success: '#72C08A', warning: '#E2B35F', danger: '#EC7A70', selected: '#1B2533' }
const TONE = { accent: C.accent, warning: C.warning, danger: C.danger, success: C.success, muted: C.muted }

const fit = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n))
const fitL = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s.padStart(n))

type Mode =
  | { kind: 'list' }
  | { kind: 'approve'; run: string; editing: boolean; text: string }
  | { kind: 'ship'; run: string }
  | { kind: 'message'; run: string; text: string }
  | { kind: 'new'; text: string }
  | { kind: 'detail'; run: string }

interface Detail { events: RunEvent[]; plan: string; pr: string; review: string }

export function App({ api, now = Date.now, onQuit = () => process.exit(0) }: { api: FlowApi; now?: () => number; onQuit?: () => void }) {
  const [, setTick] = useState(0)
  const [selected, setSelected] = useState(0)
  const [mode, setMode] = useState<Mode>({ kind: 'list' })
  const [notice, setNotice] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const { width } = useTerminalDimensions()

  useEffect(() => api.listen(m => {
    if (m.type === 'notice' && m.notice) setNotice(`${m.notice.run}: ${m.notice.text}`)
    setTick(t => t + 1)
  }), [api])
  // the clock moves even when nothing happens (elapsed times, deadlines)
  useEffect(() => { const t = setInterval(() => setTick(x => x + 1), 30_000); return () => clearInterval(t) }, [])

  const runs = [...api.runs.values()]
  const t = now()
  const list = rows(runs, t)
  const items = attention(runs, t)
  const h = header(runs, api.windows, t)
  const current = list[Math.min(selected, list.length - 1)]
  const state = current ? api.runs.get(current.run) : undefined

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

  useKeyboard(key => {
    const name = key.name, typed = key.sequence && key.sequence.length === 1 && key.sequence >= ' ' ? key.sequence : ''
    if (mode.kind === 'new') {
      if (name === 'escape') return setMode({ kind: 'list' })
      if (name === 'backspace') return setMode({ kind: 'new', text: mode.text.slice(0, -1) })
      if (name === 'return') {
        const [project, ticket, base] = mode.text.trim().split(/\s+/)
        if (!project || !ticket || !/^\d+$/.test(ticket)) return setNotice('type: <project> <ticket number> [base]')
        return void send({ cmd: 'start', project, ticket: Number(ticket), ...(base ? { base } : {}) }, `starting ${project}-${ticket}`)
      }
      if (typed) setMode({ kind: 'new', text: mode.text + typed })
      return
    }
    if (mode.kind === 'message' || (mode.kind === 'approve' && mode.editing)) {
      const text = mode.text
      if (name === 'escape') return setMode({ kind: 'list' })
      if (name === 'backspace') return setMode({ ...mode, text: text.slice(0, -1) })
      if (name === 'return') {
        if (!text.trim()) return
        if (mode.kind === 'message') return void send({ cmd: 'message', run: mode.run, text: text.trim() }, `message sent to ${mode.run}`)
        const answers = Object.fromEntries(text.trim().split(/\s+/).map(p => p.split('=')).filter(p => p.length === 2 && p[1]).map(([k, v]) => [k!.toUpperCase(), v!]))
        return void send({ cmd: 'approve', run: mode.run, answers }, `plan approved: ${mode.run}`)
      }
      if (typed) setMode({ ...mode, text: text + typed })
      return
    }
    if (mode.kind === 'approve') {
      if (typed === 'y') return void send({ cmd: 'approve', run: mode.run }, `plan approved with the defaults: ${mode.run}`)
      if (typed === 'e') return setMode({ ...mode, editing: true, text: '' })
      if (typed === 'n' || name === 'escape') return setMode({ kind: 'list' })
      return
    }
    if (mode.kind === 'ship') {
      if (typed === 'y') return void send({ cmd: 'ship', run: mode.run }, `shipping ${mode.run}: commit, push, draft PR`)
      if (typed === 'n' || name === 'escape') return setMode({ kind: 'list' })
      return
    }
    if (name === 'escape' && mode.kind === 'detail') return setMode({ kind: 'list' })
    if (typed === 'q') return onQuit()
    if (typed === 'n') return setMode({ kind: 'new', text: '' })
    if (name === 'down' || typed === 'j') return setSelected(s => Math.min(s + 1, list.length - 1))
    if (name === 'up' || typed === 'k') return setSelected(s => Math.max(s - 1, 0))
    if (!state) return
    if (name === 'return') return setMode({ kind: 'detail', run: state.id })
    if (typed === 'a') return state.needs?.kind === 'plan' ? setMode({ kind: 'approve', run: state.id, editing: false, text: '' }) : setNotice(`${state.ticket}: no plan is waiting for you`)
    if (typed === 's') return state.needs?.kind === 'ship' ? setMode({ kind: 'ship', run: state.id }) : setNotice(`${state.ticket} is not ready to ship`)
    if (typed === 'm') return setMode({ kind: 'message', run: state.id, text: '' })
    if (typed === 'p') return state.pr ? void send({ cmd: 'port', run: state.id }, `porting ${state.ticket} to develop`) : setNotice(`${state.ticket} has no draft PR to port yet`)
  })

  const titleW = Math.max(16, width - 9 - 1 - 8 - 22 - 7 - 7 - 22 - 4)
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <text>
        <strong>flow</strong>
        <span fg={C.muted}>{'   '}</span>
        <span fg={C.accent}>● </span><span fg={C.text}>{h.active}</span><span fg={C.muted}> active   </span>
        <span fg={C.warning}>▲ </span><span fg={C.text}>{h.needYou}</span><span fg={C.muted}> need you   </span>
        <span fg={C.secondary}>◌ </span><span fg={C.text}>{h.waiting}</span><span fg={C.muted}> waiting   </span>
        <span fg={C.muted}>5h </span><span fg={C.text}>{h.fiveHour}</span><span fg={C.muted}>{h.fiveHourReset ? ` (resets ${h.fiveHourReset})` : ''}   week </span><span fg={C.text}>{h.week}</span>
      </text>
      <text> </text>
      {mode.kind === 'detail' && state ? <DetailView run={state} detail={detail} now={t} /> : (
        <>
          <Attention items={items} />
          <text> </text>
          <text><strong>Runs</strong><span fg={C.muted}> {list.length}</span></text>
          <text fg={C.muted}>{`${fit('Run', 9)} ${fit('Task', titleW)} ${fit('Stage', 8)}${fit('Status', 22)}${fitL('Time', 6)} ${fitL('Tokens', 6)}  ${fit('Next', 22)}`}</text>
          {list.length ? list.map((r, i) => <RunRow key={r.run} row={r} selected={i === selected} titleW={titleW} />) : <text fg={C.muted}>No runs yet. Start one: flow start &lt;project&gt; &lt;ticket&gt;</text>}
        </>
      )}
      <text> </text>
      <Bar mode={mode} run={mode.kind !== 'list' && mode.kind !== 'new' ? api.runs.get(mode.run) : undefined} notice={notice} />
    </box>
  )
}

function Attention({ items }: { items: AttentionItem[] }) {
  return (
    <box flexDirection="column">
      <text><strong>Needs attention</strong><span fg={C.warning}> {items.length}</span>{items.length ? <span fg={C.faint}>   held first, then by deadline</span> : null}</text>
      {items.length ? items.map(a => (
        <box key={a.run} flexDirection="column">
          <text>
            <span fg={C.secondary}>{fit(a.ticket, 9)}</span> <strong>{fit(a.title, 34)}</strong> <span fg={C.muted}>{fit(a.project, 5)}</span>
            <span fg={TONE[a.tone]}> ◆ {fit(a.label, 15)}</span><span fg={C.secondary}>{fit(a.when, 18)}</span>
            <strong>{a.key}</strong><span fg={C.secondary}> {a.action}</span>
          </text>
          <text fg={C.muted}>{`          ${a.detail.slice(0, 110)}`}</text>
        </box>
      )) : <text fg={C.muted}>Nothing needs you.</text>}
    </box>
  )
}

function RunRow({ row: r, selected, titleW }: { row: Row; selected: boolean; titleW: number }) {
  return (
    <box backgroundColor={selected ? C.selected : undefined}>
      <text>
        <span fg={selected ? C.text : C.secondary}>{fit(r.ticket, 9)} </span>
        <span fg={r.tone === 'success' && !selected ? C.muted : C.text}>{fit(r.title, titleW)} </span>
        <span fg={TONE[r.tone]}>{fit(r.track, 8)}</span>
        <span fg={TONE[r.tone]}>{fit(r.status, 22)}</span>
        <span fg={C.secondary}>{fitL(r.elapsed, 6)} {fitL(r.tokens, 6)}  </span>
        <span fg={r.mine ? C.warning : C.muted}>{fit(r.next, 22)}</span>
      </text>
    </box>
  )
}

const eventLine = (e: RunEvent) => {
  const d = e.type === 'verify.result' ? (e.ok ? 'no new findings' : `${e.newFindings.length} new`) : e.type === 'plan.submitted' ? `${e.questions.length} question(s)`
    : e.type === 'plan.decided' ? `by ${e.by}` : e.type === 'tokens.used' ? tokens(e.tokens) : e.type === 'run.blocked' || e.type === 'setup.failed' ? e.reason
    : e.type === 'tool.denied' ? `${e.tool}: ${e.detail}` : e.type === 'pr.opened' ? e.url : e.type === 'human.message' ? e.text : e.type === 'run.paused' ? `until ${hhmm(e.until)}` : ''
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

function Bar({ mode, run, notice }: { mode: Mode; run?: RunState; notice: string | null }) {
  if (mode.kind === 'approve' && run) {
    if (mode.editing) return <text><span fg={C.warning}>Answers </span><span fg={C.text}>{mode.text}▏</span><span fg={C.muted}>   e.g. Q1=yes Q2=no · ↵ approve · esc cancel</span></text>
    return (
      <box flexDirection="column">
        <text><strong>Approve {run.ticket} with the defaults?</strong></text>
        {(run.plan?.questions ?? []).map(q => <text key={q.id} fg={C.secondary}>{`  ${q.id}${q.held ? ' (held)' : ''} ${q.text} → ${q.default}`}</text>)}
        <text><strong>y</strong><span fg={C.warning}> approve</span><span fg={C.muted}>   </span><strong>e</strong><span fg={C.secondary}> other answers</span><span fg={C.muted}>   </span><strong>n</strong><span fg={C.secondary}> cancel</span></text>
      </box>
    )
  }
  if (mode.kind === 'ship' && run) return <text><strong>Ship {run.ticket}?</strong><span fg={C.secondary}> commit, push, open a draft PR   </span><strong>y</strong><span fg={C.success}> ship</span><span fg={C.muted}>   </span><strong>n</strong><span fg={C.secondary}> cancel</span></text>
  if (mode.kind === 'new') return (
    <box flexDirection="column">
      {notice ? <text fg={C.accent}>{notice}</text> : null}
      <text><span fg={C.accent}>New run </span><span fg={C.text}>{mode.text}▏</span><span fg={C.muted}>   &lt;project&gt; &lt;ticket number&gt; [base] · ↵ start · esc cancel</span></text>
    </box>
  )
  if (mode.kind === 'message' && run) return <text><span fg={C.accent}>Message {run.ticket} </span><span fg={C.text}>{mode.text}▏</span><span fg={C.muted}>   ↵ send · esc cancel</span></text>
  return (
    <box flexDirection="column">
      {notice ? <text fg={C.accent}>{notice}</text> : null}
      <text fg={C.muted}>{mode.kind === 'detail' ? 'esc back   a approve   m message   s ship   p port   q quit' : '↑↓/jk move   ↵ open   n new   a approve   m message   s ship   p port   q quit'}</text>
    </box>
  )
}

