import type { KeyEvent } from '@opentui/core'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Command, Query, Reply } from '../service.ts'
import { C } from './detail.tsx'
import { changes, fields, get, itemsMap, mapItems, SECTIONS, set, shown, type FieldDef, type Json } from './settings-model.ts'

/** what the settings screen needs from the service connection */
export interface SettingsApi {
  query?<T>(q: Query): Promise<T>
  send(c: Command): Promise<Reply>
}

const fit = (s: string, n: number) => (n <= 0 ? '' : s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n))
function Click({ on, children }: { on: () => void; children: ReactNode }) { return <box onMouseDown={on}>{children}</box> }
const asText = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v))

type Edit = { kind: 'text'; value: string } | { kind: 'list'; items: string[]; index: number; adding: string | null }

/**
 * A project's settings: sections on the left, their fields on the right. Toggles and choices change with space or
 * ←→, text and numbers with ↵, lists in an editor (a add, x remove). S shows the changes against the file and saves
 * on y; the file is checked first, and new runs take the settings at once.
 */
export function ProjectSettings({ api, project, width, height, bind, bindPaste, onBack, onSaved }: {
  api: SettingsApi; project: string; width: number; height: number
  bind: (keys: ((key: KeyEvent, typed: string) => boolean) | null) => void
  bindPaste?: (f: ((text: string) => void) | null) => void
  onBack: () => void; onSaved: (text: string) => void
}) {
  const [file, setFile] = useState<{ path: string; json: Json } | null>(null)
  const [json, setJson] = useState<Json | null>(null)
  const [error, setError] = useState('')
  const [section, setSection] = useState(0)
  const [focus, setFocus] = useState<'sections' | 'fields'>('sections')
  const [at, setAt] = useState(0)
  const [repo, setRepo] = useState(0)
  // the edit being typed lives in a ref: keys can come faster than the screen redraws, and each must see the last
  const editRef = useRef<Edit | null>(null)
  const [, redraw] = useState(0)
  const setEdit = (e: Edit | null) => { editRef.current = e; redraw(x => x + 1) }
  const edit = editRef.current
  const [review, setReview] = useState(false)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    void api.query?.<{ path: string; json: Json }>({ q: 'projectFile', project }).then(f => { setFile(f); setJson(f.json) }).catch(e => setError((e as Error).message))
  }, [project])

  const sec = SECTIONS[section]!
  const list = json ? fields(sec, json, repo) : []
  const usable = (f?: FieldDef) => !!f && f.kind !== 'heading' && f.kind !== 'locked'
  const cur = Math.min(at, Math.max(0, list.length - 1))
  const f = list[cur]
  const pending = file && json ? changes(file.json, json) : []
  const repos = ((json ? get(json, ['repos']) : []) as { key?: string }[] | undefined) ?? []

  const change = (fd: FieldDef, v: unknown) => { if (json && fd.path) setJson(set(json, fd.path, v)) }
  const moveField = (d: number) => {
    let i = cur
    for (let n = 0; n < list.length; n++) { i = Math.max(0, Math.min(list.length - 1, i + d)); if (usable(list[i]) || i === 0 || i === list.length - 1) break }
    setAt(i)
  }
  const step = (fd: FieldDef, d: number) => {
    if (!json) return
    const v = shown(fd, json)
    if (fd.kind === 'toggle') change(fd, !v) // an inverted toggle is only shown the other way round
    else if (fd.kind === 'select') { const o = fd.options ?? []; change(fd, o[(o.indexOf(String(v)) + d + o.length) % o.length]) }
    else if (fd.kind === 'number') change(fd, Math.max(0, Number(v ?? 0) + d))
    else if (fd.kind === 'percent') change(fd, Math.round(Math.max(0.05, Math.min(1, Number(v ?? 0) + d * 0.05)) * 100) / 100)
  }
  const open = (fd: FieldDef) => {
    if (!json) return
    if (fd.kind === 'add') return change(fd, fd.value)
    if (fd.kind === 'text') return setEdit({ kind: 'text', value: asText(shown(fd, json)) })
    if (fd.kind === 'number') return setEdit({ kind: 'text', value: asText(shown(fd, json)) })
    if (fd.kind === 'percent') return setEdit({ kind: 'text', value: String(Math.round(Number(shown(fd, json) ?? 0) * 100)) })
    if (fd.kind === 'list') return setEdit({ kind: 'list', items: ((get(json, fd.path!) as string[]) ?? []).map(String), index: 0, adding: null })
    if (fd.kind === 'map') return setEdit({ kind: 'list', items: mapItems(get(json, fd.path!)), index: 0, adding: null })
    step(fd, 1)
  }
  const commit = () => {
    const edit = editRef.current
    if (!edit || !f) return
    if (edit.kind === 'text') {
      const v = edit.value.trim()
      if (f.kind === 'number') { if (/^\d+$/.test(v)) change(f, Number(v)); else return setError('a whole number, please') }
      else if (f.kind === 'percent') { if (/^\d+$/.test(v) && Number(v) > 0 && Number(v) <= 100) change(f, Number(v) / 100); else return setError('a share from 1 to 100') }
      else change(f, v === '' && f.fallback === undefined ? undefined : edit.value)
    } else change(f, f.kind === 'map' ? itemsMap(edit.items) : edit.items)
    setEdit(null); setError('')
  }
  const save = async () => {
    if (!json || !file) return
    const r = await api.send({ cmd: 'saveProject', project, json })
    if (r.ok) { setFile({ ...file, json }); setReview(false); onSaved(`${project}: settings saved, new runs use them`) }
    else { setReview(false); setError(r.error) }
  }

  const keys = (key: KeyEvent, typed: string): boolean => {
    const n = key.name, edit = editRef.current
    if (key.ctrl && n === 'k') return false // the commands, over this screen
    if (review) {
      if (typed === 'y') void save()
      else if (typed === 'd') { if (file) setJson(file.json); setReview(false) }
      else if (typed === 'n' || n === 'escape') setReview(false)
      return true
    }
    if (edit?.kind === 'text') {
      if (n === 'escape') setEdit(null)
      else if (n === 'return') commit()
      else if (n === 'backspace') setEdit({ ...edit, value: edit.value.slice(0, -1) })
      else if (typed) setEdit({ ...edit, value: edit.value + typed })
      return true
    }
    if (edit?.kind === 'list') {
      if (edit.adding !== null) {
        if (n === 'escape') setEdit({ ...edit, adding: null })
        else if (n === 'return') setEdit({ ...edit, items: edit.adding.trim() ? [...edit.items, edit.adding.trim()] : edit.items, index: edit.items.length, adding: null })
        else if (n === 'backspace') setEdit({ ...edit, adding: edit.adding.slice(0, -1) })
        else if (typed) setEdit({ ...edit, adding: edit.adding + typed })
        return true
      }
      if (n === 'escape') setEdit(null)
      else if (n === 'return') commit()
      else if (n === 'down' || typed === 'j') setEdit({ ...edit, index: Math.min(edit.index + 1, edit.items.length - 1) })
      else if (n === 'up' || typed === 'k') setEdit({ ...edit, index: Math.max(edit.index - 1, 0) })
      else if (typed === 'a') setEdit({ ...edit, adding: '' })
      else if (typed === 'x') setEdit({ ...edit, items: edit.items.filter((_, i) => i !== edit.index), index: Math.max(0, Math.min(edit.index, edit.items.length - 2)) })
      return true
    }
    setError('')
    if (n === 'escape') {
      if (pending.length && !leaving) { setLeaving(true); return true }
      onBack(); return true
    }
    setLeaving(false)
    if (typed === 'S') { if (pending.length) setReview(true); return true }
    if (n === 'tab') { setFocus(x => (x === 'sections' ? 'fields' : 'sections')); return true }
    if (focus === 'sections') {
      if (n === 'down' || typed === 'j') { setSection(s => Math.min(s + 1, SECTIONS.length - 1)); setAt(0) }
      else if (n === 'up' || typed === 'k') { setSection(s => Math.max(s - 1, 0)); setAt(0) }
      else if (n === 'return' || n === 'right' || typed === 'l') { setFocus('fields'); setAt(list.findIndex(usable) >= 0 ? list.findIndex(usable) : 0) }
      return true
    }
    if (sec === 'Repos' && (typed === ']' || typed === '[')) { setRepo(r => (r + (typed === ']' ? 1 : repos.length - 1)) % Math.max(1, repos.length)); setAt(0); return true }
    if (n === 'down' || typed === 'j') moveField(1)
    else if (n === 'up' || typed === 'k') moveField(-1)
    else if (!f || !usable(f)) return true
    else if (n === 'left' || n === 'right') step(f, n === 'right' ? 1 : -1)
    else if (typed === ' ') step(f, 1)
    else if (n === 'return') open(f)
    return true
  }
  useEffect(() => { bind(keys); return () => bind(null) })
  // pasted text: into a text being edited, or a list item being added (a field not being typed in takes none)
  const paste = (text: string) => {
    const one = text.replace(/\r?\n/g, ' ').trim(), edit = editRef.current
    if (edit?.kind === 'text') setEdit({ ...edit, value: edit.value + one })
    else if (edit?.kind === 'list' && edit.adding !== null) setEdit({ ...edit, adding: edit.adding + one })
  }
  useEffect(() => { bindPaste?.(paste); return () => bindPaste?.(null) })

  const W = width - 2, side = 20, right = W - side - 3
  const rows = Math.max(5, height - 8)
  const value = (fd: FieldDef): ReactNode => {
    if (!json) return null
    const v = shown(fd, json), dflt = fd.path && get(json, fd.path) === undefined
    if (fd.kind === 'toggle') { const on = fd.invert ? !v : !!v; return <><span fg={on ? C.accent : C.muted}>{on ? '[x] ' : '[ ] '}</span><span fg={C.text}>{on ? 'on' : 'off'}</span></> }
    if (fd.kind === 'select') return <>{(fd.options ?? []).map(o => <span key={o} fg={o === v ? C.text : C.secondary}>{`${o === v ? '(•)' : '( )'} ${o}   `}</span>)}</>
    if (fd.kind === 'percent') return <span fg={dflt ? C.secondary : C.text}>{`${Math.round(Number(v ?? 0) * 100)}%`}</span>
    if (fd.kind === 'list' || fd.kind === 'map') {
      const items = fd.kind === 'map' ? mapItems(v) : ((v as string[]) ?? []).map(String)
      const head = items.slice(0, 6).join('  ')
      return <><span fg={C.text}>{head || '(none)'}</span><span fg={C.muted}>{items.length > 6 ? `  +${items.length - 6}` : ''}</span></>
    }
    if (fd.kind === 'add') return <span fg={C.accent}>+ add</span>
    return <span fg={dflt ? C.secondary : C.text}>{asText(v) || (fd.kind === 'text' ? '(empty)' : '')}</span>
  }
  const row = (fd: FieldDef, i: number) => {
    const on = focus === 'fields' && i === cur
    if (fd.kind === 'heading') return <text key={i}><strong>{fd.label}</strong>{fd.hint ? <span fg={C.faint}>{`   ${fd.hint}`}</span> : null}</text>
    if (fd.kind === 'locked') return <text key={i}><span fg={C.muted}>{'  ⊘ '}</span><span fg={C.danger}>{fd.path ? '' : 'no '}</span>{fd.path ? <><span fg={C.muted}>{fit(fd.label, 14)}</span><span fg={C.text}>{asText(json ? get(json, fd.path) : '')}</span><span fg={C.faint}>{`   ${fd.hint ?? ''}`}</span></> : <span fg={C.secondary}>{fd.hint}</span>}</text>
    const editing = on && edit?.kind === 'text'
    return (
      <Click key={i} on={() => { setFocus('fields'); setAt(i); if (on) open(fd) }}>
        <box backgroundColor={on ? C.selected : undefined}>
          <text>
            <span fg={on ? C.accent : C.muted}>{`${on ? '▌ ' : '  '}${fit(fd.label, 15)}`}</span>
            {editing ? <><span fg={C.text}>{(edit as { value: string }).value}</span><span fg={C.accent}>▏</span><span fg={C.faint}>   ↵ keep · esc cancel</span></> : value(fd)}
            {!editing && fd.hint ? <span fg={C.faint}>{`   ${fd.hint}`}</span> : null}
          </text>
        </box>
      </Click>
    )
  }
  const first = Math.max(0, Math.min(cur - Math.floor(rows / 2), list.length - rows))
  const rule = <text fg={C.faint}>{'─'.repeat(W)}</text>
  return (
    <box flexDirection="column">
      <text>
        <span fg={C.muted}>{' ← esc  '}</span><strong>{project}</strong><span fg={C.text}>{`  ${asText(json ? get(json, ['name']) : '')}`}</span><span fg={C.muted}>{'   settings   '}</span>
        <span fg={C.faint}>{file ? file.path.replace(process.env.HOME ?? '~', '~') : ''}</span>
        {pending.length ? <span fg={C.warning}>{`   ${pending.length} change${pending.length === 1 ? '' : 's'} not saved`}</span> : null}
      </text>
      {rule}
      <box flexDirection="row" height={rows + 1}>
        <box flexDirection="column" width={side}>
          {SECTIONS.map((s, i) => (
            <Click key={s} on={() => { setSection(i); setAt(0); setFocus('sections') }}>
              <box backgroundColor={i === section ? C.selected : undefined}><text>{i === section ? <span fg={C.accent}>{focus === 'sections' ? '▌ ' : '  '}</span> : '  '}<span fg={i === section ? C.text : C.secondary}>{s}</span></text></box>
            </Click>
          ))}
        </box>
        <box flexDirection="column" width={right + 2} border={['left']} borderColor={C.faint} paddingLeft={1}>
          {error && !json ? <text fg={C.danger}>{error}</text> : !json ? <text fg={C.muted}>reading the settings…</text> : null}
          {sec === 'Repos' && repos.length ? (
            <box flexDirection="row">
              {repos.map((r, i) => <Click key={i} on={() => { setRepo(i); setAt(0) }}><text fg={i === repo ? C.text : C.secondary}>{i === repo ? <strong>{` ${r.key} `}</strong> : ` ${r.key} `}{'  '}</text></Click>)}
              <text fg={C.faint}>{'   [ ] repo'}</text>
            </box>
          ) : null}
          {list.slice(first, first + rows - (sec === 'Repos' ? 1 : 0)).map((fd, i) => row(fd, first + i))}
        </box>
      </box>
      {rule}
      <text fg={error ? C.danger : leaving ? C.warning : C.muted}>{error ? ` ${error}` : leaving ? ` ${pending.length} change${pending.length === 1 ? '' : 's'} not saved: S shows and saves them · esc again leaves without them` : ' '}</text>
      <text fg={C.muted}>{edit?.kind === 'list' ? ' j/k move   a add   x remove   ↵ keep the list   esc cancel' : ' ⇥ sections/fields   ↑↓ move   space/←→ change   ↵ edit   S save (shows the change first)   esc back'}</text>
      {edit?.kind === 'list' && f ? (
        <box position="absolute" top={6} left={side + 6} width={Math.min(70, right)} flexDirection="column" border borderStyle="rounded" borderColor={C.faint} backgroundColor={C.panel} zIndex={30} paddingLeft={1} paddingRight={1}>
          <text><strong>{f.label}</strong><span fg={C.faint}>{`   ${edit.items.length} · a add · x remove · ↵ keep · esc cancel`}</span></text>
          {edit.items.slice(Math.max(0, edit.index - 8), Math.max(0, edit.index - 8) + 12).map(it => {
            const i = edit.items.indexOf(it), on = i === edit.index
            return <text key={`${i}-${it}`}><span fg={on ? C.accent : C.faint}>{on ? '▸ ' : '  '}</span><span fg={on ? C.text : C.secondary}>{it}</span></text>
          })}
          {edit.adding !== null ? <text><span fg={C.accent}>{'+ '}</span><span fg={C.text}>{edit.adding}</span><span fg={C.accent}>▏</span><span fg={C.faint}>{f.kind === 'map' ? '   app=pattern' : ''}</span></text> : null}
        </box>
      ) : null}
      {review ? (
        <box position="absolute" top={4} left={Math.max(2, Math.floor((width - 90) / 2))} width={Math.min(90, width - 4)} flexDirection="column" border borderStyle="rounded" borderColor={C.accent} backgroundColor={C.panel} zIndex={30} paddingLeft={1} paddingRight={1}>
          <text><strong>{`Save ${project}'s settings?`}</strong><span fg={C.faint}>{`   ${pending.length} change${pending.length === 1 ? '' : 's'} · ${file?.path.replace(process.env.HOME ?? '~', '~')}`}</span></text>
          <text> </text>
          {pending.slice(0, 14).flatMap((c, i) => [
            <text key={`w${i}`} fg={C.secondary}>{c.where}</text>,
            ...(c.added || c.removed ? [...(c.added ?? []).map(a => <text key={`a${i}${a}`} fg={C.success}>{`  + ${a}`}</text>), ...(c.removed ?? []).map(r => <text key={`r${i}${r}`} fg={C.danger}>{`  - ${r}`}</text>)]
              : [<text key={`c${i}`}>{c.before !== undefined ? <span fg={C.danger}>{`  - ${fit(asText(c.before), 60)}`}</span> : null}{c.after !== undefined ? <span fg={C.success}>{`  + ${fit(asText(c.after), 60)}`}</span> : <span fg={C.muted}>  removed</span>}</text>]),
          ])}
          <text> </text>
          <text fg={C.muted}>New runs get these at once; runs already going keep what they started with.</text>
          <text fg={C.muted}>The file is checked first: a mistake is named, and nothing is written.</text>
          <text> </text>
          <box flexDirection="row">
            <Click on={() => void save()}><box backgroundColor={C.accent}><text fg={C.panel}><strong>{' y save '}</strong></text></box></Click>
            <Click on={() => setReview(false)}><text fg={C.muted}>{'   n keep editing   '}</text></Click>
            <Click on={() => { if (file) setJson(file.json); setReview(false) }}><text fg={C.muted}>d discard the changes</text></Click>
          </box>
        </box>
      ) : null}
    </box>
  )
}
