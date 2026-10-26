import { existsSync } from 'node:fs'
import { EmbeddedTerminalRenderable, type KeyEvent } from '@opentui/core'
import { extend } from '@opentui/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { RunEvent, RunState } from '../run.ts'
import type { Change, FileDiff, RunFile, RunLog } from '../server.ts'
import type { Entry } from '../transcript.ts'
import { DiffPopup, MarkdownPopup, type PopupKeys } from './popups.tsx'
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

import { C, sessionLines, workingLine, wrap, type Line, type Seg } from './session.ts'
export { C, wrap, type Line, type Seg } from './session.ts'
const fit = (s: string, n: number) => (n <= 0 ? '' : s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n))

interface Review { review: number; findings: { severity: string; file: string; line?: number; problem: string }[]; dropped: number; below?: { severity: string; file: string; line?: number; problem: string; confidence: number }[] }

/** what a line of the run column opens: a file as Markdown, or the change (at a file) */
export type Target = { kind: 'md'; file: RunFile } | { kind: 'diff'; file?: string }
export type RunLine = Line & { open?: Target }

/** the run column: what it needs, the plan and its answers, the checks, the changes, the timeline */
export function runLines(r: RunState, o: { plan: string; review: string; changes: Change[]; events: RunEvent[]; width: number }): RunLine[] {
  const w = o.width - 1, out: RunLine[] = []
  const push = (l: Line, open?: Target) => out.push(Object.assign(l, open ? { open } : {}))
  const head = (t: string, extra: Line = [], open?: Target) => push([[` ${t}`, C.text], ...extra, ...(open ? [['  ↗', C.faint] as Seg] : [])], open)
  const blank = () => out.push([])
  out.push(r.needs ? [[' Needs you: ', C.warning], [fit(r.needs.ask, w - 12), C.warning]] : [[` ${r.status === 'done' ? 'Done' : 'Nothing needs you right now'}`, C.muted]])
  blank()
  head('Plan', [], { kind: 'md', file: 'plan.md' })
  // the plan's first paragraph, its Markdown marks dropped (a click opens the whole of it)
  const summary = o.plan.replace(/^#.*\n/, '').trim().split(/\n\s*\n/)[0]?.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ') ?? ''
  const plan = wrap(summary || (r.plan?.summary ?? '') || 'no plan yet', w - 1)
  for (const l of plan.slice(0, 4)) push([[` ${l}`, C.secondary]], { kind: 'md', file: 'plan.md' })
  if (plan.length > 4) push([[' … the rest: click Plan', C.faint]], { kind: 'md', file: 'plan.md' })
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
  push(review
    ? [[' review  ', C.muted], [review.findings.length ? `${review.findings.length} finding${review.findings.length === 1 ? '' : 's'}` : 'nothing ≥80%', review.findings.length ? C.warning : C.success], [` · ${review.below?.length ?? review.dropped} below`, C.muted]]
    : [[' review  ', C.muted], ['not run yet', C.muted]], review ? { kind: 'md', file: 'review.json' } : undefined)
  for (const [i, f] of (review?.findings ?? []).slice(0, 3).entries()) push([[`   R${i + 1} [${f.severity}] ${fit(`${f.file}${f.line ? `:${f.line}` : ''} ${f.problem}`, w - 12)}`, C.warning]], { kind: 'md', file: 'review.json' })
  blank()
  const add = o.changes.reduce((n, c) => n + c.added, 0), del = o.changes.reduce((n, c) => n + c.removed, 0)
  head('Changes', o.changes.length ? [[`  ${o.changes.length} file${o.changes.length === 1 ? '' : 's'}  `, C.muted], [`+${add} `, C.success], [`−${del}`, C.danger]] : [['  none yet', C.muted]], o.changes.length ? { kind: 'diff' } : undefined)
  const many = new Set(o.changes.map(c => c.repo)).size > 1
  for (const c of o.changes.slice(0, 5)) {
    const name = many ? `${c.repo}/${c.file}` : c.file
    const nums = `+${c.added} −${c.removed}`
    push([[` ${c.status} `, c.status === 'A' ? C.success : c.status === 'D' ? C.danger : C.secondary], [fit(name, Math.max(6, w - nums.length - 4)), C.secondary], [` ${nums}`, C.muted]], { kind: 'diff', file: c.file })
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
interface Shell { proc?: Bun.Subprocess; out: Uint8Array[]; size: number; term?: EmbeddedTerminalRenderable; ended: boolean; problem?: string }
const shells = new Map<string, Shell>()
export function stopShells() { for (const s of shells.values()) { try { s.proc?.kill() } catch {} } shells.clear() }
process.on('exit', stopShells)

/** the run's shell, started once; one that ended stays ended (its message shown) until i asks for a new one */
function shellFor(run: string, cwd: string, cols: number, rows: number, redraw: () => void): Shell {
  const had = shells.get(run)
  if (had) return had
  const sh: Shell = { out: [], size: 0, ended: false }
  shells.set(run, sh)
  if (!existsSync(cwd)) return Object.assign(sh, { ended: true, problem: `The worktree is not there (${cwd}).` })
  try {
    sh.proc = Bun.spawn([process.env.FLOW_SHELL ?? process.env.SHELL ?? '/bin/zsh'], {
      cwd, env: { ...process.env, TERM: 'xterm-256color', FLOW_RUN: run },
      terminal: { cols, rows, data: (_t, d) => { const copy = new Uint8Array(d); sh.out.push(copy); sh.size += copy.length; while (sh.size > 512_000 && sh.out.length > 1) sh.size -= sh.out.shift()!.length; sh.term?.write(copy) } },
    })
    void sh.proc.exited.then(() => { sh.ended = true; redraw() })
  } catch (e) { Object.assign(sh, { ended: true, problem: `The shell could not start: ${(e as Error).message}` }) }
  return sh
}

/** the run's worktree in your editor: FLOW_EDITOR, else VS Code's `code` */
export function openEditor(dir: string) {
  if (!dir || !existsSync(dir)) return
  try { Bun.spawn([process.env.FLOW_EDITOR ?? 'code', dir], { stdout: 'ignore', stderr: 'ignore' }) } catch {}
}

export type Pane = 'agent' | 'metro' | 'devserver' | 'shell'

/** a command of the palette: what it says, and what choosing it does */
export interface PaletteAction { label: string; hint?: string; run: () => void }

/** the keys the detail handles itself; the rest (esc, a, S, p, ^K, q) go back to the screen */
export type DetailKeys = (key: KeyEvent, typed: string) => boolean

function Click({ on, children }: { on: () => void; children: ReactNode }) { return <box onMouseDown={on}>{children}</box> }
const Row = ({ l }: { l: Line; w?: number }) => <text>{l.length ? l.map(([t, c], i) => <span key={i} fg={c || undefined}>{t}</span>) : ' '}</text>

export function RunDetail({ api, run, now, width, height, message, bind, onMessage, onBack, onKey, bindCommands, bindPaste }: {
  api: DetailApi; run: RunState; now: number; width: number; height: number; message: string
  onBack: () => void
  /** a key the screen handles (a, S, p, ^K), pressed from the key line */
  onKey: (typed: string) => void
  /** the detail's own commands, for the palette */
  bindCommands?: (c: (() => PaletteAction[]) | null) => void
  /** pasted text: into the shell (as a terminal paste) or the message box */
  bindPaste?: (f: ((text: string, bytes: Uint8Array) => void) | null) => void
  /** the screen hands its keys here first */
  bind: (keys: DetailKeys | null) => void
  onMessage: (text: string) => Promise<boolean> | void
}) {
  const [pane, setPane] = useState<Pane>('agent')
  /** a pop-up over the detail: a file as Markdown, or the change to comment on */
  const [popup, setPopup] = useState<Target | null>(null)
  // the pop-up's keys: a ref (it hands them over on each draw; a state would draw again, without end)
  const popupKeys = useRef<PopupKeys | null>(null)
  const [split, setSplit] = useState(false)
  // o: every prompt and tool output shown whole (Claude Code's ctrl+o)
  const [full, setFull] = useState(false)
  const [focus, setFocus] = useState<'none' | 'message' | 'shell'>('none')
  // the draft in a ref too: enter right after a burst of keys must send all of them
  const [draft, setDraftState] = useState('')
  const draftRef = useRef('')
  const setDraft = (f: (d: string) => string) => { draftRef.current = f(draftRef.current); setDraftState(draftRef.current) }
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

  useEffect(() => { if (popup?.kind === 'md') { setText(''); void api.file(run.id, popup.file).then(setText) } }, [api, run.id, popup])
  useEffect(() => { if (popup?.kind === 'diff') { setDiffs(null); void (api.diff?.(run.id) ?? Promise.resolve([])).then(setDiffs).catch(() => setDiffs([])) } }, [api, run.id, popup?.kind])
  useEffect(() => { setScroll(0) }, [top])

  // the shell: started when its pane is first shown, its output replayed into each new terminal
  const shell = showsShell && data.worktree ? shellFor(run.id, data.worktree, right - 2, shellRows, () => redraw(x => x + 1)) : shells.get(run.id)
  useEffect(() => {
    if (!showsShell || !shell || !term) return
    shell.term = term
    for (const chunk of shell.out) term.write(chunk)
    // one way in for keys: flow writes each key itself; from the terminal only its own replies (a focused terminal
    // also turns keys into input, and passing that on as well typed every key twice)
    term.onData = (d, source) => { if (!shell.ended && source !== 'input') shell.proc?.terminal?.write(d) }
    return () => { if (shell.term === term) shell.term = undefined }
  }, [showsShell, shell, term])
  useEffect(() => { if (shell && !shell.ended) shell.proc?.terminal?.resize(right - 2, shellRows) }, [shell, right, shellRows])

  // the panes this run has: Metro only with a device, the dev server only when it has one (a web or backend run)
  const panes: { key: Pane; label: string }[] = [{ key: 'agent', label: 'Agent' },
    ...(run.device ? [{ key: 'metro' as const, label: 'Metro' }] : []), ...(run.devServer ? [{ key: 'devserver' as const, label: 'Dev server' }] : []), { key: 'shell', label: 'Shell' }]
  const order = panes.map(p => p.key)
  const openPane = (k: Pane) => { setPane(k); setFocus(k === 'agent' ? 'message' : 'none') }
  const keys: DetailKeys = (key, typed) => {
    if (popup) { popupKeys.current?.(key, typed); return true }
    if (focus === 'shell') {
      if (key.ctrl && key.name === ']') { setFocus('none'); return true }
      if (shell && !shell.ended && term) shell.proc?.terminal?.write(term.encodeKey(key))
      return true
    }
    if (focus === 'message') {
      if (key.name === 'escape') { setFocus('none'); return true }
      if (key.name === 'return') {
        const text = draftRef.current.trim()
        // the draft is cleared once the service took it; a refused message stays to send again
        if (text) void Promise.resolve(onMessage(text)).then(ok => { if (ok !== false && draftRef.current.trim() === text) setDraft(() => '') })
        setFocus('none'); return true
      }
      if (key.name === 'backspace') { setDraft(d => d.slice(0, -1)); return true }
      if (typed) setDraft(d => d + typed)
      return true
    }
    if (typed === ']' || typed === '[') {
      setPane(panes[(Math.max(0, order.indexOf(top)) + (typed === ']' ? 1 : order.length - 1)) % order.length]!.key)
      return true
    }
    if (typed === 'v') { setSplit(x => !x); return true }
    if (typed === 'o') { setFull(x => !x); return true }
    if (typed === 'e') { openEditor(data.worktree); return true }
    if (typed === 'd') { setPopup({ kind: 'diff' }); return true }
    if (typed === 'P') { setPopup({ kind: 'md', file: 'plan.md' }); return true }
    if (typed === 'i') { if (shells.get(run.id)?.ended) { shells.delete(run.id); redraw(x => x + 1) } if (!showsShell) setPane('shell'); setFocus('shell'); return true }
    if (typed === 'm') { setPane(p => (split ? p : 'agent')); setFocus('message'); return true }
    return false
  }
  useEffect(() => { bind(keys); return () => bind(null) })
  // what the palette offers in the detail: its pop-ups and panes
  const commands = (): PaletteAction[] => [
    { label: 'Message the agent', hint: 'm', run: () => { setPane(p => (split ? p : 'agent')); setFocus('message') } },
    { label: 'Open the change', hint: 'd · comment on its lines', run: () => setPopup({ kind: 'diff' }) },
    { label: 'Open the plan', hint: 'P', run: () => setPopup({ kind: 'md', file: 'plan.md' }) },
    { label: 'Open the ticket', hint: 'ticket.md', run: () => setPopup({ kind: 'md', file: 'ticket.md' }) },
    { label: 'Open the PR description', hint: 'pr.md', run: () => setPopup({ kind: 'md', file: 'pr.md' }) },
    { label: 'Open the review', hint: 'its findings', run: () => setPopup({ kind: 'md', file: 'review.json' }) },
    ...panes.filter(x => x.key !== 'shell').map(x => ({ label: `Show ${x.label === 'Agent' ? "the agent's session" : x.label}`, hint: 'pane', run: () => { setPane(x.key); setFocus('none') } })),
    { label: 'Open the worktree in VS Code', hint: 'e', run: () => openEditor(data.worktree) },
    { label: 'Type in the shell', hint: 'i · in the worktree', run: () => { if (!showsShell) setPane('shell'); setFocus('shell') } },
    { label: split ? 'Unsplit' : 'Split with the shell', hint: 'v', run: () => setSplit(x => !x) },
  ]
  useEffect(() => { bindCommands?.(commands); return () => bindCommands?.(null) })
  const paste = (text: string, bytes: Uint8Array) => {
    if (focus === 'shell' && shell && !shell.ended && term) shell.proc?.terminal?.write(term.encodePaste(bytes))
    else if (focus === 'message') setDraft(d => d + text.replace(/\r?\n/g, ' '))
  }
  useEffect(() => { bindPaste?.(paste); return () => bindPaste?.(null) })

  const session = sessionLines(entries, right - 2, full)
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
      const since = [...entries].reverse().find(e => e.kind === 'prompt')?.at ?? now
      const lines = working ? [...session, [], workingLine(entries, since, now)] : session
      return (
        <box flexDirection="column" height={rows} onMouseScroll={e => wheel(e, lines.length - rows)}>
          {lines.length ? view(lines, rows).map((l, i) => <Row key={i} l={[[' ', C.text], ...l]} w={right} />) : <text fg={C.muted}> No agent session recorded for this run yet.</text>}
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
    return null
  }

  const shellPane = (rows: number) => (
    <box flexDirection="column" height={rows + 1} onMouseDown={() => setFocus('shell')}>
      <text><strong>{' Shell '}</strong><span fg={C.secondary}>{`· ${data.worktree ? data.worktree.replace(process.env.HOME ?? '~', '~') : 'no worktree yet'} `}</span>{focus === 'shell' ? <span fg={C.accent}>● typing here · ctrl+] leaves</span> : <span fg={C.faint}>i or a click to type here</span>}</text>
      {shell && !shell.ended ? <terminal ref={setTerm} width={right - 2} height={rows} cols={right - 2} rows={rows} />
        : <text fg={C.muted}>{shell?.problem ? ` ${shell.problem}` : shell?.ended ? ' The shell ended. i starts a new one.' : data.worktree ? ' Starting…' : ' The run has no worktree yet.'}</text>}
    </box>
  )

  const tab = (t: { key: Pane; label: string }) => {
    const k = t.key
    const on = top === k || (k === 'shell' && showsShell)
    const dot = k === 'agent' ? (working ? C.success : '') : k === 'metro' || k === 'devserver' ? C.success : k === 'shell' ? (shell && !shell.ended ? C.success : '') : ''
    return <Click key={t.label} on={() => openPane(k)}><box backgroundColor={on ? undefined : C.panel} paddingLeft={1} paddingRight={1}><text>{on ? <strong>{t.label}</strong> : <span fg={C.muted}>{t.label}</span>}{dot ? <span fg={dot}> ●</span> : ''}</text></box></Click>
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
    : [['esc back', onBack], ['d diff', () => setPopup({ kind: 'diff' })], ['P plan', () => setPopup({ kind: 'md', file: 'plan.md' })], ['[ ] pane', () => keys(fake(']'), ']')], ['v split', () => setSplit(x => !x)], ['e code', () => openEditor(data.worktree)], ...(pane === 'agent' ? [[full ? 'o fold' : 'o show all', () => setFull(x => !x)] as [string, () => void]] : []), ['i shell', () => keys(fake('i'), 'i')], ['m message', () => keys(fake('m'), 'm')],
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
        <span fg={C.muted}>{`   ${tokens(run.tokens)} tokens${run.cached ? ` (+${tokens(run.cached)} from cache)` : ''} · ${run.compactions} compaction${run.compactions === 1 ? '' : 's'}`}</span>
        {run.device ? <span fg={C.secondary}>{`   ${run.device.platform} ${run.device.id} · Metro :${run.device.metroPort}`}</span> : null}
        {run.patch ? <span fg={C.secondary}>{`   patch ${run.patch.customer}/${run.patch.app}`}</span> : null}
        {run.pr ? <span fg={C.success}>{`   draft PR #${run.pr.number}`}</span> : null}
      </text>
      {rule}
      <box flexDirection="row" height={body}>
        <box flexDirection="column" width={left}>
          {runCol.slice(0, body - 1).map((l, i) => (l.open ? <Click key={i} on={() => setPopup(l.open!)}><Row l={l} /></Click> : <Row key={i} l={l} w={left} />))}
          <box flexDirection="row">
            <text fg={C.muted}>{' Open '}</text>
            {(['ticket.md', 'plan.md', 'pr.md', 'review.json'] as RunFile[]).map(f => <Click key={f} on={() => setPopup({ kind: 'md', file: f })}><text fg={C.accent}>{`${f.replace('.json', '')}  `}</text></Click>)}
            <Click on={() => setPopup({ kind: 'diff' })}><text fg={C.accent}>diff</text></Click>
          </box>
        </box>
        <box flexDirection="column" width={right + 1} border={['left']} borderColor={C.faint}>
          <box flexDirection="row" backgroundColor={C.panel}>
            {panes.map(tab)}
            <Click on={() => setSplit(x => !x)}><text fg={C.faint}>{split ? '   ⊟ split on (v)' : '   ⊟ split (v)'}</text></Click>
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
      {popup?.kind === 'md' ? <MarkdownPopup title={popup.file === 'review.json' ? 'Review' : popup.file} content={popup.file === 'review.json' ? reviewText(text) : text} width={W - 2} height={height - 4}
        bind={k => { popupKeys.current = k }} onClose={() => setPopup(null)} /> : null}
      {popup?.kind === 'diff' ? <DiffPopup run={run.id} diffs={diffs} file={popup.file} width={W - 2} height={height - 4}
        bind={k => { popupKeys.current = k }} onClose={() => setPopup(null)} onSend={onMessage} /> : null}
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
