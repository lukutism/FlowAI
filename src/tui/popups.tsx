import { RGBA, SyntaxStyle, type KeyEvent, type ScrollBoxRenderable } from '@opentui/core'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { FileDiff } from '../server.ts'

/** The run detail's pop-ups: a file drawn as Markdown, and the change to read line by line and comment on. */

const C = { text: '#DDE2E8', secondary: '#A3ABB5', muted: '#6D7681', faint: '#434A54', accent: '#78A6EC', success: '#72C08A', warning: '#E2B35F', danger: '#EC7A70', selected: '#1B2533', panel: '#161A20', add: '#16261C', del: '#2B1A1A', comment: '#2A2416' }

export const md = SyntaxStyle.fromStyles({
  default: { fg: RGBA.fromHex('#A3ABB5') }, 'markup.heading': { fg: RGBA.fromHex('#DDE2E8'), bold: true }, 'markup.strong': { fg: RGBA.fromHex('#DDE2E8'), bold: true },
  'markup.italic': { italic: true }, 'markup.raw': { fg: RGBA.fromHex('#E2B35F') }, 'markup.link': { fg: RGBA.fromHex('#78A6EC'), underline: true }, 'markup.list': { fg: RGBA.fromHex('#78A6EC') },
})

export type PopupKeys = (key: KeyEvent, typed: string) => boolean
function Click({ on, children }: { on: () => void; children: ReactNode }) { return <box onMouseDown={on}>{children}</box> }
const fit = (s: string, n: number) => (n <= 0 ? '' : s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n))

/** a pop-up's frame: over the screen, its title, its body, its keys */
function Frame({ title, extra, keys, width, height, children }: { title: string; extra?: ReactNode; keys: [string, () => void][]; width: number; height: number; children: ReactNode }) {
  return (
    <box position="absolute" top={2} left={2} width={width} height={height} zIndex={30} flexDirection="column" border borderStyle="rounded" borderColor={C.faint} backgroundColor={C.panel}>
      <text>{' '}<strong>{title}</strong>{extra}</text>
      <text fg={C.faint}>{'─'.repeat(Math.max(0, width - 2))}</text>
      {children}
      <box flexDirection="row"><text>{' '}</text>{keys.map(([k, on]) => <Click key={k} on={on}><text fg={C.muted}>{`${k}   `}</text></Click>)}</box>
    </box>
  )
}

/** a file of the run as Markdown: j/k or the wheel scroll it, esc closes */
export function MarkdownPopup({ title, content, width, height, bind, onClose }: { title: string; content: string; width: number; height: number; bind: (k: PopupKeys | null) => void; onClose: () => void }) {
  const box = useRef<ScrollBoxRenderable | null>(null)
  const page = Math.max(1, height - 6)
  const keys: PopupKeys = (key, typed) => {
    const n = key.name
    if (n === 'escape' || typed === 'q') { onClose(); return true }
    if (n === 'down' || typed === 'j') box.current?.scrollBy(1)
    if (n === 'up' || typed === 'k') box.current?.scrollBy(-1)
    if (n === 'pagedown' || typed === ' ') box.current?.scrollBy(page)
    if (n === 'pageup' || typed === 'b') box.current?.scrollBy(-page)
    if (typed === 'g') box.current?.scrollTo(0)
    if (typed === 'G') box.current?.scrollTo(1e9)
    return true
  }
  useEffect(() => { bind(keys); return () => bind(null) })
  return (
    <Frame title={title} width={width} height={height} keys={[['j/k scroll', () => box.current?.scrollBy(1)], ['space page', () => box.current?.scrollBy(page)], ['esc close', onClose]]}>
      <scrollbox ref={box} height={height - 5} width={width - 2} paddingLeft={1} paddingRight={1}>
        {content.trim() ? <markdown content={content} syntaxStyle={md} /> : <text fg={C.muted}>It is empty.</text>}
      </scrollbox>
    </Frame>
  )
}

/** a line of a change: a file's header, a hunk's header, or a line of code with its numbers before and after */
export interface DiffLine { repo: string; file: string; kind: 'file' | 'hunk' | 'ctx' | 'add' | 'del' | 'big'; old?: number; new?: number; text: string; status?: FileDiff['status']; added?: number; removed?: number }

/** the change as lines to move through: each file, then its hunks' lines numbered */
export function diffLines(diffs: FileDiff[]): DiffLine[] {
  const out: DiffLine[] = []
  for (const d of diffs) {
    out.push({ repo: d.repo, file: d.file, kind: 'file', text: d.file, status: d.status, added: d.added, removed: d.removed })
    if (!d.patch) { out.push({ repo: d.repo, file: d.file, kind: 'big', text: 'too large to show here: open it in the Shell (git diff)' }); continue }
    let o = 0, n = 0, inHunk = false
    for (const l of d.patch.split('\n')) {
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l)
      if (h) { o = Number(h[1]); n = Number(h[2]); inHunk = true; out.push({ repo: d.repo, file: d.file, kind: 'hunk', text: h[3]!.trim() }); continue }
      if (!inHunk || l.startsWith('\\')) continue
      if (l.startsWith('+')) out.push({ repo: d.repo, file: d.file, kind: 'add', new: n++, text: l.slice(1) })
      else if (l.startsWith('-')) out.push({ repo: d.repo, file: d.file, kind: 'del', old: o++, text: l.slice(1) })
      else if (l.startsWith(' ')) out.push({ repo: d.repo, file: d.file, kind: 'ctx', old: o++, new: n++, text: l.slice(1) })
    }
  }
  return out
}

/** a comment on a line of the change, before it is sent */
export interface Comment { repo: string; file: string; line: number; side: 'new' | 'old'; code: string; text: string }
const at = (l: DiffLine) => (l.kind === 'del' ? { line: l.old!, side: 'old' as const } : { line: l.new!, side: 'new' as const })
const same = (c: Comment, l: DiffLine) => c.repo === l.repo && c.file === l.file && c.line === at(l).line && c.side === at(l).side

/** the comments as one message to the agent, the way a reviewer writes them */
export function reviewMessage(comments: Comment[], manyRepos = false): string {
  const parts = comments.map(c => `${manyRepos ? `${c.repo}/` : ''}${c.file}:${c.line}${c.side === 'old' ? ' (a removed line)' : ''}\n> ${c.code.trim()}\n${c.text}`)
  return `Review comments on your change (${comments.length}):\n\n${parts.join('\n\n')}\n\nAddress each one in the code, or answer it if you disagree; then stop.`
}

// the comments not sent yet, per run: they stay while the screen runs, the pop-up closed or not
const pending = new Map<string, Comment[]>()

/**
 * The change, line by line: j/k move, c (or a click on the selected line) comments the line, x removes its comment,
 * S sends the comments to the agent as one message, esc closes (the comments wait for the next time).
 */
export function DiffPopup({ run, diffs, file, width, height, bind, onClose, onSend }: {
  run: string; diffs: FileDiff[] | null; file?: string; width: number; height: number
  bind: (k: PopupKeys | null) => void; onClose: () => void; onSend: (text: string) => Promise<boolean> | void
}) {
  const lines = diffLines(diffs ?? [])
  const code = (i: number) => ['ctx', 'add', 'del'].includes(lines[i]?.kind ?? '')
  const first = Math.max(0, file ? lines.findIndex(l => l.kind === 'file' && l.file === file) : 0)
  const [cur, setCur] = useState(first)
  const [comments, setState] = useState<Comment[]>(pending.get(run) ?? [])
  // kept for the next time the change is opened, at once (the pop-up may close in the same moment, as after sending)
  const setComments = (f: Comment[] | ((cs: Comment[]) => Comment[])) => setState(cs => { const next = typeof f === 'function' ? f(cs) : f; pending.set(run, next); return next })
  const [draft, setDraft] = useState<string | null>(null)
  useEffect(() => { setCur(first) }, [diffs === null, file])
  const rows = Math.max(3, height - 6)
  const sel = Math.min(cur, Math.max(0, lines.length - 1))
  const many = new Set((diffs ?? []).map(d => d.repo)).size > 1

  const comment = () => { if (code(sel)) setDraft(comments.find(c => same(c, lines[sel]!))?.text ?? '') }
  const save = (text: string) => {
    const l = lines[sel]!
    const rest = comments.filter(c => !same(c, l))
    setComments(text.trim() ? [...rest, { repo: l.repo, file: l.file, ...at(l), code: l.text, text: text.trim() }] : rest)
    setDraft(null)
  }
  // the comments are dropped once the service took them; refused (the agent is busy), they stay for another try
  const send = async () => {
    if (!comments.length) return
    if ((await onSend(reviewMessage(comments, many))) === false) return
    pending.delete(run); setComments([]); onClose()
  }
  const move = (d: number) => setCur(c => Math.max(0, Math.min(lines.length - 1, Math.min(c, lines.length - 1) + d)))
  const keys: PopupKeys = (key, typed) => {
    const n = key.name
    if (draft !== null) {
      if (n === 'escape') setDraft(null)
      else if (n === 'return') save(draft)
      else if (n === 'backspace') setDraft(d => (d ?? '').slice(0, -1))
      else if (typed) setDraft(d => (d ?? '') + typed)
      return true
    }
    if (n === 'escape' || typed === 'q') { onClose(); return true }
    if (n === 'down' || typed === 'j') move(1)
    else if (n === 'up' || typed === 'k') move(-1)
    else if (n === 'pagedown' || typed === ' ') move(rows)
    else if (n === 'pageup' || typed === 'b') move(-rows)
    else if (typed === 'g') setCur(0)
    else if (typed === 'G') setCur(lines.length - 1)
    else if (typed === ']') { const i = lines.findIndex((l, j) => j > sel && l.kind === 'file'); if (i >= 0) setCur(i) }
    else if (typed === '[') { const i = lines.map((l, j) => (j < sel && l.kind === 'file' ? j : -1)).filter(j => j >= 0).pop(); if (i !== undefined) setCur(i) }
    else if (typed === 'c' || n === 'return') comment()
    else if (typed === 'x') setComments(cs => cs.filter(c => !(lines[sel] && same(c, lines[sel]!))))
    else if (typed === 'S') send()
    return true
  }
  useEffect(() => { bind(keys); return () => bind(null) })

  // the window of lines around the cursor; a line's comment (or the one being written) is drawn under it
  const top = Math.max(0, Math.min(sel - Math.floor(rows / 3), lines.length - rows))
  const shown: ReactNode[] = []
  let used = 0
  for (let i = top; i < lines.length && used < rows; i++) {
    const l = lines[i]!, on = i === sel
    const mark = <span fg={on ? C.accent : C.faint}>{on ? '▌' : ' '}</span>
    if (l.kind === 'file') shown.push(
      <Click key={i} on={() => setCur(i)}><box backgroundColor={on ? C.selected : undefined}><text>{mark}<span fg={l.status === 'A' ? C.success : l.status === 'D' ? C.danger : C.accent}>{` ${l.status} `}</span><strong>{many ? `${l.repo}/${l.file}` : l.file}</strong><span fg={C.muted}>{`  +${l.added} −${l.removed}`}</span></text></box></Click>)
    else if (l.kind === 'hunk' || l.kind === 'big') shown.push(<Click key={i} on={() => setCur(i)}><box backgroundColor={on ? C.selected : undefined}><text>{mark}<span fg={C.faint}>{`      ${l.kind === 'hunk' ? `@@ ${l.text}` : l.text}`}</span></text></box></Click>)
    else {
      const bg = on ? C.selected : l.kind === 'add' ? C.add : l.kind === 'del' ? C.del : undefined
      const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '
      shown.push(
        <Click key={i} on={() => (on ? comment() : setCur(i))}>
          <box backgroundColor={bg}><text>{mark}<span fg={C.faint}>{`${String(l.old ?? '').padStart(5)} ${String(l.new ?? '').padStart(5)} `}</span><span fg={l.kind === 'add' ? C.success : l.kind === 'del' ? C.danger : C.faint}>{`${sign} `}</span><span fg={C.text}>{fit(l.text.replace(/\t/g, '  '), width - 19)}</span></text></box>
        </Click>)
    }
    used++
    const c = code(i) ? comments.find(x => same(x, l)) : undefined
    if (on && draft !== null) { shown.push(<box key={`d${i}`} backgroundColor={C.comment}><text><span fg={C.warning}>{'              ┃ '}</span><span fg={C.text}>{draft}</span><span fg={C.accent}>▏</span><span fg={C.faint}>   ↵ save · esc cancel</span></text></box>); used++ }
    else if (c) { shown.push(<Click key={`c${i}`} on={() => { setCur(i); setDraft(c.text) }}><box backgroundColor={C.comment}><text><span fg={C.warning}>{'              ┃ '}</span><span fg={C.text}>{fit(c.text, width - 20)}</span></text></box></Click>); used++ }
  }
  const files = (diffs ?? []).length, add = (diffs ?? []).reduce((n, d) => n + d.added, 0), del = (diffs ?? []).reduce((n, d) => n + d.removed, 0)
  return (
    <Frame title="Diff" width={width} height={height}
      extra={<><span fg={C.muted}>{diffs === null ? '  reading the change…' : `  ${files} file${files === 1 ? '' : 's'}  `}</span>{files ? <><span fg={C.success}>{`+${add} `}</span><span fg={C.danger}>{`−${del}`}</span></> : null}<span fg={C.faint}>{'   from where the branch left its base'}</span>{comments.length ? <span fg={C.warning}>{`   ${comments.length} comment${comments.length === 1 ? '' : 's'} not sent`}</span> : null}</>}
      keys={draft !== null ? [['typing a comment', () => {}], ['↵ save', () => save(draft)], ['esc cancel', () => setDraft(null)]] : [
        ['j/k line', () => move(1)], ['[ ] file', () => keys({ name: '', sequence: ']' } as KeyEvent, ']')], ['c comment', comment], ['x remove', () => keys({ name: '', sequence: 'x' } as KeyEvent, 'x')],
        [comments.length ? `S send ${comments.length} comment${comments.length === 1 ? '' : 's'} to the agent` : 'S send', send], ['esc close', onClose]]}>
      <box flexDirection="column" height={rows} onMouseScroll={e => { const d = e.scroll?.direction; if (d === 'down') move(3); if (d === 'up') move(-3) }}>
        {lines.length ? shown : <text fg={C.muted}>{diffs === null ? ' …' : ' No change yet.'}</text>}
      </box>
    </Frame>
  )
}
