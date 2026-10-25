import { EmbeddedTerminalRenderable, RGBA, SyntaxStyle, type KeyEvent } from '@opentui/core'
import { extend } from '@opentui/react'
import { useEffect, useState, type ReactNode } from 'react'
import type { RunEvent, RunState } from '../run.ts'
import type { Change, FileDiff, RunFile, RunLog } from '../server.ts'
import type { Entry } from '../transcript.ts'
import { describeEvent, duration, hhmm, line as lineOf, tokens, track } from './model.ts'

extend({ terminal: EmbeddedTerminalRenderable })

/** what the run detail needs from the service connection */
export interface DetailApi {
  listen(fn: (m: { type: string; run?: string; entry?: Entry }) => void): () => void
  events(run: string): Promise<RunEvent[]>
  file(run: string, name: RunFile): Promise<string>
  transcript?(run: string): Promise<Entry[]>
  log?(run: string, name: RunLog, lines: number): Promise<string[]>
  changes?(run: string): Promise<Change[]>
  diff?(run: string): Promise<FileDiff[]>
}

export const C = { text: '#DDE2E8', secondary: '#A3ABB5', muted: '#6D7681', faint: '#434A54', accent: '#78A6EC', success: '#72C08A', warning: '#E2B35F', danger: '#EC7A70', selected: '#1B2533', panel: '#161A20' }
/** how Markdown (plan, ticket, PR, review) is drawn: the screen's colours */
const md = SyntaxStyle.fromStyles({
  default: { fg: RGBA.fromHex('#A3ABB5') }, 'markup.heading': { fg: RGBA.fromHex('#DDE2E8'), bold: true }, 'markup.strong': { fg: RGBA.fromHex('#DDE2E8'), bold: true },
  'markup.italic': { italic: true }, 'markup.raw': { fg: RGBA.fromHex('#E2B35F') }, 'markup.link': { fg: RGBA.fromHex('#78A6EC'), underline: true }, 'markup.list': { fg: RGBA.fromHex('#78A6EC') },
})

const fit = (s: string, n: number) => (n <= 0 ? '' : s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n))

/** a line as coloured pieces */
export type Seg = [text: string, color: string]
export type Line = Seg[]

/** words wrapped to a width (long words are cut) */
export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let cur = ''
    for (const w of para.split(/\s+/).filter(Boolean)) {
      if (!cur) cur = w
      else if (cur.length + 1 + w.length <= width) cur += ` ${w}`
      else { out.push(cur); cur = w }
      while (cur.length > width) { out.push(cur.slice(0, width)); cur = cur.slice(width) }
    }
    out.push(cur)
  }
  while (out.length && !out[out.length - 1]) out.pop()
  return out
}

/** what a tool call was about, in one line */
export function toolSummary(input: Record<string, unknown>): string {
  const v = input.command ?? input.file_path ?? input.pattern ?? input.path ?? input.url ?? input.description ?? input.query
  return typeof v === 'string' ? v.replace(/\s+/g, ' ') : JSON.stringify(input).slice(0, 80)
}

/** the agent session as lines for a pane of the given width: who spoke when, the tools it ran, turn ends */
export function sessionLines(entries: Entry[], width: number): Line[] {
  const out: Line[] = []
  const body = Math.max(10, width - 14)
  const said = (at: number, who: string, color: string, text: string, textColor: string) => {
    wrap(text, body).forEach((l, i) => out.push(i ? [[' '.repeat(14), ''], [l, textColor]] : [[`${hhmm(at)} `, C.muted], [who.padEnd(8), color], [l, textColor]]))
  }
  for (const e of entries) {
    const agent = e.own ? 'claude' : 'review'
    if (e.kind === 'prompt') {
      if (e.from === 'you') said(e.at, 'you', C.text, e.text, C.text)
      else {
        const lines = e.text.split('\n').filter(l => l.trim())
        out.push([[`${hhmm(e.at)} `, C.muted], ['flow    ', C.warning], [fit(lines[0] ?? '', body - 12), C.secondary], [lines.length > 1 ? ` (+${lines.length - 1} lines)` : '', C.faint]])
      }
    } else if (e.kind === 'session') out.push([[`${agent} · session ${e.session.slice(0, 6)} · ${e.model}`, C.faint]])
    else if (e.kind === 'text') said(e.at, agent, e.own ? C.accent : C.secondary, e.text, C.secondary)
    else if (e.kind === 'tool') out.push([['        ⋯ ', C.muted], [e.name.padEnd(6), C.muted], [fit(toolSummary(e.input), body - 6), C.secondary]])
    else if (e.kind === 'denied') out.push([['        ✕ ', C.danger], [e.tool.padEnd(6), C.danger], [fit(toolSummary(e.input), body - 26), C.secondary], ['   refused by flow', C.danger]])
    else if (e.kind === 'compaction') out.push([[`        ── context compacted ${tokens(e.before)} → ${tokens(e.after)} ──`, C.faint]])
    else if (e.kind === 'result') {
      const n = e.tokens.input + e.tokens.output + e.tokens.cacheRead + e.tokens.cacheWrite
      out.push([[e.ok ? `        ── turn ended · ${tokens(n)} tokens · ${e.turns} turn${e.turns === 1 ? '' : 's'} ──` : `        ── turn failed: ${fit(e.text || e.reason, body - 20)} ──`, e.ok ? C.faint : C.danger]])
    }
  }
  return out
}

interface Review { review: number; findings: { severity: string; file: string; line?: number; problem: string }[]; dropped: number; below?: { severity: string; file: string; line?: number; problem: string; confidence: number }[] }

/** the run column: what it needs, the plan and its answers, the checks, the changes, the timeline */
export function runLines(r: RunState, o: { plan: string; review: string; changes: Change[]; events: RunEvent[]; width: number }): Line[] {
  const w = o.width - 1, out: Line[] = []
  const head = (t: string, extra: Line = []) => out.push([[` ${t}`, C.text], ...extra])
  const blank = () => out.push([])
  out.push(r.needs ? [[' Needs you: ', C.warning], [fit(r.needs.ask, w - 12), C.warning]] : [[` ${r.status === 'done' ? 'Done' : 'Nothing needs you right now'}`, C.muted]])
  blank()
  head('Plan')
  // the plan's first paragraph, its Markdown marks dropped (the Plan pane draws the whole of it)
  const summary = o.plan.replace(/^#.*\n/, '').trim().split(/\n\s*\n/)[0]?.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ') ?? ''
  const plan = wrap(summary || (r.plan?.summary ?? '') || 'no plan yet', w - 1)
  for (const l of plan.slice(0, 4)) out.push([[` ${l}`, C.secondary]])
  if (plan.length > 4) out.push([[' … plan.md has the rest', C.faint]])
  for (const q of r.plan?.questions ?? []) {
    const a = r.plan?.answers?.[q.id]
    wrap(`${q.id}${q.held ? ' (held)' : ''} ${q.text}`, w - 1).slice(0, 2).forEach(l => out.push([[` ${l}`, C.muted]]))
    out.push(a ? [['    → ', C.muted], [fit(a, w - 16), C.text], [r.plan?.decidedBy ? ` · ${r.plan.decidedBy === 'human' ? 'you' : 'deadline'}` : '', C.muted]] : [[`    default: ${fit(q.default, w - 14)}`, C.muted]])
  }
  blank()
  head('Checks')
  const v = [...o.events].reverse().find(e => e.type === 'verify.result')
  out.push(v && v.type === 'verify.result'
    ? [[' verify  ', C.muted], [v.ok ? '✓ no new findings' : `✕ ${v.newFindings.length} new finding${v.newFindings.length === 1 ? '' : 's'}`, v.ok ? C.success : C.danger], [` · ${r.loops.verifyRuns} run${r.loops.verifyRuns === 1 ? '' : 's'}`, C.muted]]
    : [[' verify  ', C.muted], ['not run yet', C.muted]])
  if (v && v.type === 'verify.result' && !v.ok) for (const f of v.newFindings.slice(0, 3)) out.push([[`   ${fit(f, w - 3)}`, C.danger]])
  let review: Review | undefined
  try { review = o.review.trim() ? JSON.parse(o.review) : undefined } catch {}
  out.push(review
    ? [[' review  ', C.muted], [review.findings.length ? `${review.findings.length} finding${review.findings.length === 1 ? '' : 's'}` : 'nothing ≥80%', review.findings.length ? C.warning : C.success], [` · ${review.below?.length ?? review.dropped} below`, C.muted]]
    : [[' review  ', C.muted], ['not run yet', C.muted]])
  for (const [i, f] of (review?.findings ?? []).slice(0, 3).entries()) out.push([[`   R${i + 1} [${f.severity}] ${fit(`${f.file}${f.line ? `:${f.line}` : ''} ${f.problem}`, w - 12)}`, C.warning]])
  blank()
  const add = o.changes.reduce((n, c) => n + c.added, 0), del = o.changes.reduce((n, c) => n + c.removed, 0)
  head('Changes', o.changes.length ? [[`  ${o.changes.length} file${o.changes.length === 1 ? '' : 's'}  `, C.muted], [`+${add} `, C.success], [`−${del}`, C.danger]] : [['  none yet', C.muted]])
  const many = new Set(o.changes.map(c => c.repo)).size > 1
  for (const c of o.changes.slice(0, 5)) {
    const name = many ? `${c.repo}/${c.file}` : c.file
    const nums = `+${c.added} −${c.removed}`
    out.push([[` ${c.status} `, c.status === 'A' ? C.success : c.status === 'D' ? C.danger : C.secondary], [fit(name, Math.max(6, w - nums.length - 4)), C.secondary], [` ${nums}`, C.muted]])
  }
  if (o.changes.length > 5) out.push([[`   and ${o.changes.length - 5} more`, C.faint]])
  blank()
  head('Timeline')
  for (const e of o.events.filter(x => x.type !== 'tokens.used' && x.type !== 'session.started').slice(-7)) {
    const d = describeEvent(e)
    out.push([[` ${hhmm(e.at)} `, C.muted], [d.stage.padEnd(7), C.muted], [fit(d.text, w - 14), e.actor === 'human' ? C.text : C.muted]])
  }
  return out
}

// A run's shell: a real one (a PTY) in its worktree. It outlives the pane: its output is kept and replayed into
// the terminal whenever the pane is shown again.
interface Shell { proc: Bun.Subprocess; out: Uint8Array[]; size: number; term?: EmbeddedTerminalRenderable; ended: boolean }
const shells = new Map<string, Shell>()
export function stopShells() { for (const s of shells.values()) { try { s.proc.kill() } catch {} } shells.clear() }
process.on('exit', stopShells)

function shellFor(run: string, cwd: string, cols: number, rows: number, redraw: () => void): Shell {
  const had = shells.get(run)
  if (had && !had.ended) return had
  const sh: Shell = { proc: undefined as unknown as Bun.Subprocess, out: [], size: 0, ended: false }
  sh.proc = Bun.spawn([process.env.FLOW_SHELL ?? process.env.SHELL ?? '/bin/zsh'], {
    cwd, env: { ...process.env, TERM: 'xterm-256color', FLOW_RUN: run },
    terminal: { cols, rows, data: (_t, d) => { const copy = new Uint8Array(d); sh.out.push(copy); sh.size += copy.length; while (sh.size > 512_000 && sh.out.length > 1) sh.size -= sh.out.shift()!.length; sh.term?.write(copy) } },
  })
  void sh.proc.exited.then(() => { sh.ended = true; redraw() })
  shells.set(run, sh)
  return sh
}

export type Pane = 'agent' | 'diff' | 'metro' | 'devserver' | 'shell' | 'file'

/** the keys the detail handles itself; the rest (esc, a, S, p, ^K, q) go back to the screen */
export type DetailKeys = (key: KeyEvent, typed: string) => boolean

function Click({ on, children }: { on: () => void; children: ReactNode }) { return <box onMouseDown={on}>{children}</box> }
const Row = ({ l }: { l: Line; w?: number }) => <text>{l.length ? l.map(([t, c], i) => <span key={i} fg={c || undefined}>{t}</span>) : ' '}</text>

export function RunDetail({ api, run, now, width, height, message, bind, onMessage, onBack, onKey }: {
  api: DetailApi; run: RunState; now: number; width: number; height: number; message: string
  onBack: () => void
  /** a key the screen handles (a, S, p, ^K), pressed from the key line */
  onKey: (typed: string) => void
  /** the screen hands its keys here first */
  bind: (keys: DetailKeys | null) => void
  onMessage: (text: string) => void
}) {
  const [pane, setPane] = useState<Pane>('agent')
  const [file, setFile] = useState<RunFile>('plan.md')
  const [split, setSplit] = useState(false)
  const [focus, setFocus] = useState<'none' | 'message' | 'shell'>('none')
  const [draft, setDraft] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const [text, setText] = useState('')
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null)
  const [data, setData] = useState<{ plan: string; review: string; changes: Change[]; events: RunEvent[]; worktree: string }>({ plan: '', review: '', changes: [], events: [], worktree: '' })
  const [scroll, setScroll] = useState(0)
  const [, redraw] = useState(0)
  // the shell pane's terminal (a new one each time the pane is shown): a state, so the replay runs for each
  const [term, setTerm] = useState<EmbeddedTerminalRenderable | null>(null)

  const W = width - 2, left = Math.min(42, Math.floor(W * 0.35)), right = W - left - 1
  const body = Math.max(6, height - 7)
  const top = split ? (pane === 'shell' ? 'agent' : pane) : pane
  const showsShell = pane === 'shell' || split
  const shellRows = split ? Math.max(3, Math.floor((body - 1) / 2) - 1) : body - 2
  const topRows = split ? body - 1 - (shellRows + 1) - 1 : body - 1

  // the run's data: refreshed when it changes
  useEffect(() => {
    let live = true
    void Promise.all([api.events(run.id), api.file(run.id, 'plan.md'), api.file(run.id, 'review.json'), api.changes?.(run.id) ?? Promise.resolve([]), api.file(run.id, 'run.json')])
      .then(([events, plan, review, changes, meta]) => {
        if (!live) return
        let worktree = ''
        try { worktree = (JSON.parse(meta || '{}') as { worktree?: string }).worktree ?? '' } catch {}
        setData({ events, plan, review, changes, worktree })
      })
    return () => { live = false }
  }, [api, run.id, run.updatedAt])

  // the session: what was recorded, then live
  useEffect(() => {
    let live = true
    void api.transcript?.(run.id).then(e => { if (live) setEntries(e) })
    const off = api.listen(m => { if (m.type === 'agent' && m.run === run.id && m.entry) setEntries(x => [...x, m.entry!].slice(-600)) })
    return () => { live = false; off() }
  }, [api, run.id])

  // a log pane polls its file while it is shown
  useEffect(() => {
    if (top !== 'metro' && top !== 'devserver') return
    let live = true
    const get = () => void api.log?.(run.id, top, 400).then(l => { if (live) setLogs(l) }).catch(() => {})
    get()
    const t = setInterval(get, 1000)
    return () => { live = false; clearInterval(t) }
  }, [api, run.id, top])

  useEffect(() => { if (top === 'file') void api.file(run.id, file).then(setText) }, [api, run.id, top, file])
  useEffect(() => { if (top === 'diff') void (api.diff?.(run.id) ?? Promise.resolve([])).then(setDiffs).catch(() => setDiffs([])) }, [api, run.id, top, run.updatedAt])
  useEffect(() => { setScroll(0) }, [top, file])

  // the shell: started when its pane is first shown, its output replayed into each new terminal
  const shell = showsShell && data.worktree ? shellFor(run.id, data.worktree, right - 2, shellRows, () => redraw(x => x + 1)) : shells.get(run.id)
  useEffect(() => {
    if (!showsShell || !shell || !term) return
    shell.term = term
    for (const chunk of shell.out) term.write(chunk)
    term.onData = d => { if (!shell.ended) shell.proc.terminal?.write(d) }
    return () => { if (shell.term === term) shell.term = undefined }
  }, [showsShell, shell, term])
  useEffect(() => { if (shell && !shell.ended) shell.proc.terminal?.resize(right - 2, shellRows) }, [shell, right, shellRows])

  // the panes this run has: Metro only with a device, the dev server only when it has one (a web or backend run)
  const panes: { key: Pane; label: string; file?: RunFile }[] = [{ key: 'agent', label: 'Agent' }, { key: 'diff', label: 'Diff' }, { key: 'file', label: 'Plan', file: 'plan.md' },
    ...(run.device ? [{ key: 'metro' as const, label: 'Metro' }] : []), ...(run.devServer ? [{ key: 'devserver' as const, label: 'Dev server' }] : []), { key: 'shell', label: 'Shell' }]
  const order = panes.map(p => p.key)
  const openPane = (k: Pane, f?: RunFile) => { if (f) setFile(f); setPane(k); setFocus(k === 'agent' ? 'message' : 'none') }
  const keys: DetailKeys = (key, typed) => {
    if (focus === 'shell') {
      if (key.ctrl && key.name === ']') { setFocus('none'); return true }
      if (shell && !shell.ended && term) shell.proc.terminal?.write(term.encodeKey(key))
      return true
    }
    if (focus === 'message') {
      if (key.name === 'escape') { setFocus('none'); return true }
      if (key.name === 'return') { if (draft.trim()) { onMessage(draft.trim()); setDraft('') } setFocus('none'); return true }
      if (key.name === 'backspace') { setDraft(d => d.slice(0, -1)); return true }
      if (typed) setDraft(d => d + typed)
      return true
    }
    if (typed === ']' || typed === '[') {
      const next = panes[(Math.max(0, order.indexOf(top)) + (typed === ']' ? 1 : order.length - 1)) % order.length]!
      if (next.file) setFile(next.file)
      setPane(next.key)
      return true
    }
    if (typed === 'v') { setSplit(x => !x); return true }
    if (typed === 'i') { if (!showsShell) setPane('shell'); setFocus('shell'); return true }
    if (typed === 'm') { setPane(p => (split ? p : 'agent')); setFocus('message'); return true }
    return false
  }
  useEffect(() => { bind(keys); return () => bind(null) })

  const session = sessionLines(entries, right - 2)
  const working = run.status === 'running' && entries.length > 0 && entries[entries.length - 1]!.kind !== 'result'
  const view = (lines: Line[], rows: number) => {
    const start = Math.max(0, lines.length - rows - scroll)
    return lines.slice(start, start + rows)
  }
  const wheel = (e: { scroll?: { direction: string } }, max: number) => {
    const d = e.scroll?.direction
    if (d === 'up') setScroll(s => Math.min(s + 3, Math.max(0, max)))
    if (d === 'down') setScroll(s => Math.max(0, s - 3))
  }

  const paneBody = (p: Pane, rows: number) => {
    if (p === 'agent') {
      const lines = working ? [...session, [[`${hhmm(now)} `, C.muted], ['claude  ', C.accent], ['▍ working…', C.accent]] as Line] : session
      return (
        <box flexDirection="column" height={rows} onMouseScroll={e => wheel(e, lines.length - rows)}>
          {lines.length ? view(lines, rows).map((l, i) => <Row key={i} l={l} w={right} />) : <text fg={C.muted}> No agent session recorded for this run yet.</text>}
        </box>
      )
    }
    if (p === 'metro' || p === 'devserver') {
      const what = p === 'metro' ? 'Metro' : 'dev server'
      const empty = p === 'metro' ? (run.device ? `Metro has written nothing yet` : `This run has no device, so no Metro: start a run with a device`) : run.devServer ? 'The dev server has written nothing yet' : 'This run has no dev server: start a run with one'
      const lines: Line[] = logs.map(l => [[` ${l.slice(0, right - 2)}`, /error|fail/i.test(l) ? C.danger : /warn/i.test(l) ? C.warning : C.secondary]])
      return (
        <box flexDirection="column" height={rows} onMouseScroll={e => wheel(e, lines.length - rows)}>
          <text><span fg={C.secondary}>{` ${what}`}</span>{p === 'metro' && run.device ? <span fg={C.success}>{` :${run.device.metroPort} ● running`}</span> : null}{p === 'devserver' && run.devServer ? <span fg={C.success}>{` ${run.devServer.repo} ${run.devServer.url} ● running`}</span> : null}<span fg={C.faint}>{`   ${p}.log`}</span></text>
          {lines.length ? view(lines, rows - 1).map((l, i) => <Row key={i} l={l} w={right} />) : <text fg={C.muted}>{` ${empty}`}</text>}
        </box>
      )
    }
    if (p === 'file') {
      const content = file === 'review.json' ? reviewText(text) : text
      return (
        <scrollbox height={rows} width={right} paddingLeft={1} paddingRight={1}>
          {content.trim() ? <markdown content={content} syntaxStyle={md} /> : <text fg={C.muted}>{`${file} is empty`}</text>}
        </scrollbox>
      )
    }
    if (p === 'diff') {
      const all = diffs ?? []
      const add = all.reduce((n, d) => n + d.added, 0), del = all.reduce((n, d) => n + d.removed, 0)
      const many = new Set(all.map(d => d.repo)).size > 1
      return (
        <scrollbox height={rows} width={right}>
          <text><span fg={C.secondary}>{diffs === null ? ' reading the change…' : all.length ? ` ${all.length} file${all.length === 1 ? '' : 's'}  ` : ' No change yet.'}</span>{all.length ? <><span fg={C.success}>{`+${add} `}</span><span fg={C.danger}>{`−${del}`}</span><span fg={C.faint}>   from where the branch left its base</span></> : null}</text>
          {all.map(d => (
            <box key={`${d.repo}/${d.file}`} flexDirection="column">
              <text> </text>
              <text><span fg={d.status === 'A' ? C.success : d.status === 'D' ? C.danger : C.accent}>{` ${d.status} `}</span><strong>{many ? `${d.repo}/${d.file}` : d.file}</strong><span fg={C.muted}>{`  +${d.added} −${d.removed}`}</span></text>
              {d.patch ? <diff diff={d.patch} view="unified" showLineNumbers height={Math.max(1, d.patch.split('\n').filter(l => /^[ +-]/.test(l) && !/^(\+\+\+|---) /.test(l)).length)} width={right - 1}
                addedBg="#16261C" removedBg="#2B1A1A" addedSignColor={C.success} removedSignColor={C.danger} lineNumberFg={C.faint} /> : <text fg={C.muted}>   too large to show here: open it in the Shell (git diff)</text>}
            </box>
          ))}
        </scrollbox>
      )
    }
    return null
  }

  const shellPane = (rows: number) => (
    <box flexDirection="column" height={rows + 1} onMouseDown={() => setFocus('shell')}>
      <text><strong>{' Shell '}</strong><span fg={C.secondary}>{`· ${data.worktree ? data.worktree.replace(process.env.HOME ?? '~', '~') : 'no worktree yet'} `}</span>{focus === 'shell' ? <span fg={C.accent}>● typing here · ctrl+] leaves</span> : <span fg={C.faint}>i or a click to type here</span>}</text>
      {shell && !shell.ended ? <terminal ref={setTerm} width={right - 2} height={rows} cols={right - 2} rows={rows} />
        : <text fg={C.muted}>{shell?.ended ? ' The shell ended. i starts a new one.' : data.worktree ? ' Starting…' : ' The run has no worktree yet.'}</text>}
    </box>
  )

  const tab = (t: { key: Pane; label: string; file?: RunFile }) => {
    const k = t.key
    const on = (top === k && (!t.file || file === t.file)) || (k === 'shell' && showsShell)
    const dot = k === 'agent' ? (working ? C.success : '') : k === 'metro' || k === 'devserver' ? C.success : k === 'shell' ? (shell && !shell.ended ? C.success : '') : ''
    return <Click key={t.label} on={() => openPane(k, t.file)}><box backgroundColor={on ? undefined : C.panel} paddingLeft={1} paddingRight={1}><text>{on ? <strong>{t.label}</strong> : <span fg={C.muted}>{t.label}</span>}{dot ? <span fg={dot}> ●</span> : ''}</text></box></Click>
  }
  // the message box: always right under the agent's session (above the shell when split)
  const msgBox = (
    <box flexDirection="column" onMouseDown={() => setFocus('message')}>
      <text fg={C.faint}>{'─'.repeat(right)}</text>
      <text>{focus === 'message' ? <><span fg={C.accent}>{' › '}</span><span fg={C.text}>{draft}▏</span><span fg={C.faint}>   ↵ send · esc leave</span></> : <><span fg={C.accent}>{' › '}</span><span fg={C.faint}>Message the agent… (m, or click)</span></>}</text>
    </box>
  )

  const runCol = runLines(run, { plan: data.plan, review: data.review, changes: data.changes, events: data.events, width: left })
  const fake = (typed: string, name = typed) => ({ name, ctrl: false, shift: false, meta: false, sequence: typed }) as unknown as KeyEvent
  const keyLine: [string, () => void][] = focus === 'shell' ? [['typing in Shell: keys go to the shell', () => {}], ['ctrl+] leave', () => setFocus('none')], ['^K commands', () => onKey('palette')]]
    : focus === 'message' ? [['typing a message to the agent', () => {}], ['↵ send', () => keys(fake('', 'return'), '')], ['esc leave', () => setFocus('none')]]
    : [['esc back', onBack], ['[ ] pane', () => keys(fake(']'), ']')], ['v split', () => setSplit(x => !x)], ['i shell', () => keys(fake('i'), 'i')], ['m message', () => keys(fake('m'), 'm')],
      ['a approve', () => onKey('a')], ['S ship', () => onKey('S')], ['p port', () => onKey('p')], ['^K commands', () => onKey('palette')]]
  const rule = <text fg={C.faint}>{'─'.repeat(W)}</text>
  return (
    <box flexDirection="column">
      <text onMouseDown={onBack}>
        <span fg={C.muted}>{' ← esc  '}</span>
        <span fg={C.secondary}>{`${run.ticket}  `}</span><strong>{fit(run.title, Math.max(10, W - run.ticket.length - 40))}</strong>
        <span fg={C.muted}>{`   ${run.project} · ${lineOf(run.base)}`}</span>
      </text>
      <text>
        <span fg={C.accent}>{` ${track(run)}  `}</span><span fg={C.accent}>{`${run.stage} · ${run.status} ${duration(now - run.updatedAt)}`}</span>
        <span fg={C.muted}>{`   ${tokens(run.tokens)} tokens · ${run.compactions} compaction${run.compactions === 1 ? '' : 's'}`}</span>
        {run.device ? <span fg={C.secondary}>{`   ${run.device.platform} ${run.device.id} · Metro :${run.device.metroPort}`}</span> : null}
        {run.patch ? <span fg={C.secondary}>{`   patch ${run.patch.customer}/${run.patch.app}`}</span> : null}
        {run.pr ? <span fg={C.success}>{`   draft PR #${run.pr.number}`}</span> : null}
      </text>
      {rule}
      <box flexDirection="row" height={body}>
        <box flexDirection="column" width={left}>
          {runCol.slice(0, body - 1).map((l, i) => <Row key={i} l={l} w={left} />)}
          <box flexDirection="row">
            <text fg={C.muted}>{' Open '}</text>
            {(['ticket.md', 'plan.md', 'pr.md', 'review.json'] as RunFile[]).map(f => <Click key={f} on={() => openPane('file', f)}><text fg={top === 'file' && file === f ? C.text : C.accent}>{`${f.replace('.json', '')}  `}</text></Click>)}
          </box>
        </box>
        <box flexDirection="column" width={right + 1} border={['left']} borderColor={C.faint}>
          <box flexDirection="row" backgroundColor={C.panel}>
            {panes.map(tab)}
            <Click on={() => setSplit(x => !x)}><text fg={C.faint}>{split ? '   ⊟ split on (v)' : '   ⊟ split (v)'}</text></Click>
            {top === 'file' && file !== 'plan.md' ? <text fg={C.text}>{`   ${file}`}</text> : null}
          </box>
          {split ? (
            <>
              {paneBody(top, top === 'agent' ? topRows - 2 : topRows)}
              {top === 'agent' ? msgBox : null}
              <text fg={C.faint}>{'─'.repeat(right)}</text>
              {shellPane(shellRows)}
            </>
          ) : pane === 'shell' ? shellPane(shellRows) : (
            <>
              {paneBody(top, top === 'agent' ? body - 3 : body - 1)}
              {top === 'agent' ? msgBox : null}
            </>
          )}
        </box>
      </box>
      {rule}
      <text fg={message.startsWith('✕') ? C.danger : message.startsWith('✓') ? C.success : C.accent}>{message || ' '}</text>
      <box flexDirection="row"><text>{' '}</text>{keyLine.map(([label, on]) => <Click key={label} on={on}><text fg={C.muted}>{`${label}   `}</text></Click>)}</box>
    </box>
  )
}

/** review.json as text for the file pane */
function reviewText(json: string): string {
  let r: Review
  try { r = JSON.parse(json) } catch { return json }
  return [
    `# Review ${r.review}`, '', r.findings.length ? `**${r.findings.length} finding(s)**${r.dropped ? ` · ${r.dropped} below 80% confidence left out` : ''}` : `**Nothing found**${r.dropped ? ` · ${r.dropped} below 80% confidence left out` : ''}`, '',
    ...r.findings.map((f, i) => `- **R${i + 1} [${f.severity}]** \`${f.file}${f.line ? `:${f.line}` : ''}\` ${f.problem}`),
    ...(r.below?.length ? ['', '## Below the line', '', ...r.below.map(f => `- ${f.confidence}% [${f.severity}] \`${f.file}${f.line ? `:${f.line}` : ''}\` ${f.problem}`)] : []),
  ].join('\n')
}
