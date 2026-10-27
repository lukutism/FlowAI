import type { KeyEvent } from '@opentui/core'
import { useEffect, useState, type ReactNode } from 'react'
import type { Snapshot } from '../resources.ts'
import type { Command, ProjectSummary, Query } from '../service.ts'
import { C, wrap } from './detail.tsx'
import { match } from './model.ts'
import { slug } from '../slug.ts'
import { at as noteAt, cursor as noteCursor, edit as editNote, rows as noteRows, type NoteKey, type Notes } from './notes.ts'

/** what the form needs from the service connection */
export interface FormApi {
  projects?: ProjectSummary[]
  resources?: Snapshot
  query?<T>(q: Query): Promise<T>
}

export interface Lookup {
  run: string; exists: boolean; key: string; title: string; kind: 'bug' | 'feature'; type: string; url: string; board: string; customer: string; tags: string[]; comments: number
  area?: string; platform?: string
  /** the run's environment as the ticket suggests it */
  vars?: Record<string, string>
}

type Field = 'project' | 'ticket' | 'task' | 'base' | 'kind' | 'repos' | 'device' | 'dev' | 'patch' | 'model' | 'email' | 'password' | 'license' | 'headless' | `var:${string}`
/** how many lines of the notes show at once (the last ones, as you type) */
const NOTE_ROWS = 8
const MODELS = ['default', 'opus', 'sonnet']

/** the base a ticket's release tag points at (3.18 → the newest patch/3.18.x), else none */
export function suggestBase(tags: string[], bases: string[]): string | undefined {
  const line = tags.map(t => /^(\d+\.\d+)$/.exec(t.trim())?.[1]).find(Boolean)
  return line ? bases.find(b => b.includes(`/${line}.`)) : undefined
}

/** the repos a ticket targets: each repo whose pattern matches its platform or a tag; none when nothing matches */
export function suggestRepos(t: { platform?: string; tags: string[] }, patterns: Record<string, string>, order: string[]): string[] {
  const words = [t.platform ?? '', ...t.tags].filter(Boolean)
  return order.filter(r => patterns[r] && words.some(w => new RegExp(patterns[r]!, 'i').test(w)))
}

/**
 * The customer patch a ticket points at: its customer (named on it, else in its board's name); of that customer's
 * apps the one its area names, else the one whose pattern matches its area or title (picking → product), else the
 * only one; none when it can't tell.
 */
export function suggestPatch(t: { customer: string; board: string; area?: string; title?: string; tags?: string[] }, choices: string[], apps: Record<string, string> = {}): string | undefined {
  // names as written in tickets: Müller, mueller-qa, MUELLER — umlauts as their two letters, no case, no punctuation
  const plain = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').normalize('NFKD').replace(/[^a-z0-9]/g, '')
  const who = plain(t.customer), tags = (t.tags ?? []).map(plain), board = plain(t.board)
  const named = (c: string) => { const n = plain(c.split('/')[0]!); return !!n && ((who && who.includes(n)) || tags.includes(n) || board.includes(n)) }
  const mine = choices.filter(named)
  const area = (t.area ?? '').toLowerCase()
  const text = `${t.area ?? ''} ${t.title ?? ''}`
  return mine.find(c => area && area.includes(c.split('/')[1]!))
    ?? mine.find(c => apps[c.split('/')[1]!] && new RegExp(apps[c.split('/')[1]!]!, 'i').test(text))
    ?? (mine.length === 1 ? mine[0] : undefined)
}

const fit = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n))
function Click({ on, children }: { on: () => void; children: ReactNode }) { return <box onMouseDown={on}>{children}</box> }

/** a list to choose from by typing: what matches the query, the suggestions first */
interface Picking { field: 'base' | 'patch'; query: string; index: number }
export interface Item { value: string; label: string; hint?: string }
export function pickItems(all: Item[], query: string): Item[] { return query.trim() ? all.filter(i => match(query, i.label)) : all }

/**
 * The new-run form: everything a run is started with on one panel, filled in from the ticket where it can be (kind,
 * base, repos, customer patch), checked before it starts (the ticket exists, no run has it yet, the customer patch
 * fits the base), with what will happen. Base and patch are chosen in a list you type into.
 */
export function NewRunForm({ api, width, project: initial, fixed, bind, bindPaste, onStart, onCancel }: {
  api: FormApi; width: number; project?: string
  /** the project is the screen's (its header): not asked */
  fixed?: boolean
  bind: (keys: ((key: KeyEvent, typed: string) => boolean) | null) => void
  /** pasted text, into the field being typed in */
  bindPaste?: (f: ((text: string) => void) | null) => void
  onStart: (c: Extract<Command, { cmd: 'start' }>) => void
  onCancel: () => void
}) {
  const projects = api.projects ?? []
  const [project, setProject] = useState(initial && projects.some(p => p.key === initial) ? initial : projects[0]?.key ?? '')
  const p = projects.find(x => x.key === project)
  const [ticket, setTicket] = useState('')
  /** no ticket: what to do, in your words (its first line names the run and the branch) */
  const [task, setTask] = useState('')
  // three steps: the run, notes for the agent (as long as you like), test logins (kept apart, never shown)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [notes, setNotes] = useState<Notes>({ text: '', at: 0 })
  const note = notes.text
  // the notes' width: the form's, less the box's margins and padding and a column for the cursor at a full row's end
  const noteWidth = Math.min(96, width - 8) - 11
  const [login, setLogin] = useState({ email: '', password: '', license: '' })
  // the run's environment (the project's vars): what you set, and which you changed (the ticket's suggestion stays off those)
  const [env, setEnv] = useState<Record<string, string>>({})
  const [envTouched, setEnvTouched] = useState<Set<string>>(new Set())
  const [look, setLook] = useState<{ state: 'idle' | 'loading' | 'ok' | 'error'; data?: Lookup; error?: string }>({ state: 'idle' })
  const [bases, setBases] = useState<Record<string, string[]>>({})
  const [refs, setRefs] = useState<string[]>([])
  const [base, setBase] = useState('')
  const [kind, setKind] = useState<'bug' | 'feature'>('feature')
  const [repos, setRepos] = useState<string[]>(p?.defaults ?? p?.repos.slice(0, 1) ?? [])
  const [repoAt, setRepoAt] = useState(0)
  const [device, setDevice] = useState<'none' | 'android' | 'ios'>('none')
  const [dev, setDev] = useState(false)
  // the run's emulator and browser without their windows: the project's default unless you choose
  const [headless, setHeadless] = useState(p?.headless ?? true)
  const [choices, setChoices] = useState<string[]>([])
  const [patch, setPatch] = useState('')
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null)
  const [model, setModel] = useState('default')
  const [field, setField] = useState<Field>('ticket')
  const [picking, setPicking] = useState<Picking | null>(null)
  const [problem, setProblem] = useState('')
  /** what you chose yourself since the last lookup: suggestions never overwrite it */
  const [touched, setTouched] = useState<Set<'base' | 'patch' | 'kind' | 'repos'>>(new Set())
  const touch = (f: 'base' | 'patch' | 'kind' | 'repos') => setTouched(t => new Set(t).add(f))

  // a project's own answers: its repos, bases, branches and customer patches
  useEffect(() => {
    if (!p) return
    setRepos(p.defaults ?? p.repos.slice(0, 1)); setDevice('none'); setDev(false); setHeadless(p.headless ?? true); setPatch(''); setRepoAt(0)
    void api.query?.<Record<string, string[]>>({ q: 'bases', project }).then(b => { setBases(b); setBase(b[(p.defaults ?? p.repos)[0]!]?.[0] ?? '') }).catch(() => setBases({}))
    void (p.patches.length ? api.query?.<string[]>({ q: 'patches', project }).then(setChoices).catch(() => setChoices([])) : setChoices([]))
  }, [project])
  useEffect(() => {
    if (!p || !repos[0]) return
    void api.query?.<string[]>({ q: 'refs', project, repo: repos[0] }).then(setRefs).catch(() => setRefs([]))
  }, [project, repos[0]])

  // the ticket, looked up once typing pauses
  useEffect(() => {
    if (!ticket.trim() || !api.query) { setLook({ state: 'idle' }); return }
    setLook({ state: 'loading' }); setTouched(new Set())
    let live = true
    const t = setTimeout(() => {
      void api.query!<Lookup>({ q: 'lookup', project, ticket: /^\d+$/.test(ticket) ? Number(ticket) : ticket })
        .then(d => { if (live) setLook({ state: 'ok', data: d }) })
        .catch(e => { if (live) setLook({ state: 'error', error: (e as Error).message }) })
    }, 350)
    return () => { live = false; clearTimeout(t) }
  }, [ticket, project])

  // what the ticket points at, once it and the lists are known (never over what you chose)
  useEffect(() => {
    const d = look.data
    if (look.state !== 'ok' || !d || !p) return
    if (!touched.has('kind')) setKind(d.kind)
    const r = suggestRepos(d, p.repoMatch ?? {}, p.repos)
    if (r.length && !touched.has('repos')) setRepos(r)
    const b = suggestBase(d.tags, bases[(r.length && !touched.has('repos') ? r : repos)[0] ?? ''] ?? []); if (b && !touched.has('base')) setBase(b)
    const s = suggestPatch(d, choices, p.patchApps); if (s && !touched.has('patch')) setPatch(s)
    setEnv(e => ({ ...e, ...Object.fromEntries(Object.entries(d.vars ?? {}).filter(([k]) => !envTouched.has(k))) }))
  }, [look, bases, choices])

  // whether the chosen patch fits the base
  useEffect(() => {
    if (!patch || !base || !api.query) { setCheck(null); return }
    let live = true
    void api.query<{ ok: boolean; text: string }>({ q: 'checkPatch', project, patch, base }).then(c => { if (live) setCheck(c) }).catch(() => {})
    return () => { live = false }
  }, [patch, base, project])

  const suggested = bases[repos[0] ?? ''] ?? []
  const t = look.data
  const ticketBase = t ? suggestBase(t.tags, suggested) : undefined
  const ticketPatch = t && p ? suggestPatch(t, choices, p.patchApps) : undefined
  // the picker's lists: the suggestions first (the default, the ticket's, the newest release lines), then the rest
  const baseItems: Item[] = [...new Set([...suggested, ...refs])].map(r => ({ value: r, label: r.replace(/^origin\//, ''),
    hint: r === suggested[0] ? 'the default' : r === ticketBase ? "the ticket's release line" : suggested.includes(r) ? 'release line' : r.startsWith('origin/') ? '' : 'tag' }))
  const patchItems: Item[] = [{ value: '', label: 'none', hint: 'the fix goes on the release line only' },
    ...[...choices].sort((a, b) => Number(b === ticketPatch) - Number(a === ticketPatch)).map(c => ({ value: c, label: c, hint: c === ticketPatch ? `the ticket points at it` : '' }))]
  const shown = picking ? pickItems(picking.field === 'base' ? baseItems : patchItems, picking.query) : []

  const devRepos = (p?.devServers ?? []).filter(r => repos.includes(r))
  const fields: Field[] = [...(fixed ? [] : ['project' as const]), 'ticket', ...(ticket.trim() ? [] : ['task' as const]), 'base', 'kind', 'repos', ...(p?.devices.length && repos.some(r => !(p?.devServers ?? []).includes(r)) ? ['device' as const] : []),
    ...(devRepos.length ? ['dev' as const] : []), ...(device !== 'none' || dev ? ['headless' as const] : []), ...(p?.patches.some(r => repos.includes(r)) && choices.length ? ['patch' as const] : []), 'model']
  // test logins are for the app the agent signs into: on its device, or in the browser of its dev server
  const signsIn = device !== 'none' || dev
  const loginFields: ('email' | 'password' | 'license')[] = signsIn ? ['email', 'password', ...(p?.license ? ['license' as const] : [])] : []
  const envVars = (p?.vars ?? []).filter(v => !v.repos || v.repos.some(r => repos.includes(r)))
  const stepThree: Field[] = [...loginFields, ...envVars.map(v => `var:${v.name}` as const)]
  // nothing to sign into and no environment to choose: Notes is the last step
  const hasThree = stepThree.length > 0
  const threeLabel = loginFields.length && envVars.length ? 'Login & environment' : loginFields.length ? 'Login' : 'Environment'
  const move = (d: number) => { const list: Field[] = step === 3 ? stepThree : fields; setField(f => list[(list.indexOf(f) + d + list.length) % list.length]!) }
  const setVar = (name: string, value: string) => { setEnvTouched(t => new Set([...t, name])); setEnv(e => ({ ...e, [name]: value })) }
  const cycle = <T,>(list: T[], cur: T, d: number): T => list[(list.indexOf(cur) + d + list.length) % list.length] ?? cur

  // the run's own checks: the ticket can be started (or the task is described), repos, a patch that fits
  const ready = (): boolean => {
    if (!p) { setProblem('no project: add one in ~/.config/flow/projects'); return false }
    if (!ticket.trim()) {
      if (!task.trim()) { setStep(1); setField('task'); setProblem('type the ticket, or leave it empty and describe the task'); return false }
      if (!slug(task.split('\n')[0]!)) { setStep(1); setField('task'); setProblem('describe the task in a few words: they name the run and the branch'); return false }
    } else {
      if (look.state === 'loading') { setProblem('still looking the ticket up'); return false }
      if (look.state === 'error') { setProblem(look.error ?? 'the ticket could not be read'); return false }
      if (look.data?.exists) { setProblem(`${look.data.run} exists already: open it from the runs`); return false }
    }
    if (!repos.length) { setStep(1); setField('repos'); setProblem('choose at least one repo'); return false }
    if (patch && check && !check.ok) { setStep(1); setField('patch'); setProblem('the customer patch does not fit this base: choose another base or no patch'); return false }
    return true
  }
  const go = (to: 1 | 2 | 3) => { if (to === 3 && !hasThree) return; if (to > 1 && step === 1 && !ready()) return; setProblem(''); setStep(to); if (to === 3) setField(stepThree[0]!) }
  const start = () => {
    const logins = loginFields.filter(k => login[k].trim()).map(k => `${k}: ${login[k].trim()}`).join('\n')
    const vars = Object.fromEntries(envVars.map(v => [v.name, env[v.name]?.trim() ?? '']).filter(([, x]) => x))
    const extra = { ...(note.trim() ? { note: note.trim() } : {}), ...(logins ? { logins } : {}), ...(Object.keys(vars).length ? { vars } : {}) }
    if (!ready()) return
    if (!p) return setProblem('no project: add one in ~/.config/flow/projects')
    if (!ticket.trim()) {
      // no ticket: a task described instead
      if (!task.trim()) { setField('task'); return setProblem('type the ticket, or leave it empty and describe the task') }
      if (!slug(task.split('\n')[0]!)) { setField('task'); return setProblem('describe the task in a few words: they name the run and the branch') }
      if (!repos.length) { setField('repos'); return setProblem('choose at least one repo') }
      return onStart({ cmd: 'start', project, ticket: '', task: task.trim(), ...(base ? { base } : {}), kind, repos,
        ...(device !== 'none' ? { device } : {}), ...(dev ? { devServer: true } : {}), ...(patch ? { patch } : {}), ...(model !== 'default' ? { model } : {}), ...(headless !== (p?.headless ?? true) ? { headless } : {}), ...extra })
    }
    if (look.state === 'loading') return setProblem('still looking the ticket up')
    if (look.state === 'error') return setProblem(look.error ?? 'the ticket could not be read')
    if (look.data?.exists) return setProblem(`${look.data.run} exists already: open it from the runs`)
    if (!repos.length) { setField('repos'); return setProblem('choose at least one repo') }
    if (patch && check && !check.ok) { setField('patch'); return setProblem('the customer patch does not fit this base: choose another base or no patch') }
    onStart({ cmd: 'start', project, ticket: /^\d+$/.test(ticket) ? Number(ticket) : ticket, ...(base ? { base } : {}), kind, repos,
      ...(device !== 'none' ? { device } : {}), ...(dev ? { devServer: true } : {}), ...(patch ? { patch } : {}), ...(model !== 'default' ? { model } : {}), ...(headless !== (p?.headless ?? true) ? { headless } : {}), ...extra })
  }
  const choose = (f: 'base' | 'patch', v: string) => { touch(f); if (f === 'base') setBase(v); else setPatch(v); setPicking(null) }
  const open = (f: 'base' | 'patch', query = '') => {
    setField(f)
    const all = f === 'base' ? baseItems : patchItems
    setPicking({ field: f, query, index: Math.max(0, pickItems(all, query).findIndex(i => i.value === (f === 'base' ? base : patch))) })
  }

  const keys = (key: KeyEvent, typed: string): boolean => {
    setProblem('')
    const n = key.name
    if (picking) {
      if (n === 'escape') { setPicking(null); return true }
      if (n === 'down') { setPicking(x => x && { ...x, index: Math.min(x.index + 1, shown.length - 1) }); return true }
      if (n === 'up') { setPicking(x => x && { ...x, index: Math.max(x.index - 1, 0) }); return true }
      if (n === 'return') {
        const it = shown[picking.index] ?? (picking.field === 'base' && picking.query.trim() ? { value: picking.query.trim() } : undefined)
        if (it) choose(picking.field, it.value)
        return true
      }
      if (n === 'backspace') { setPicking(x => x && { ...x, query: x.query.slice(0, -1), index: 0 }); return true }
      if (n === 'tab') { setPicking(null); move(key.shift ? -1 : 1); return true }
      if (typed) setPicking(x => x && { ...x, query: x.query + typed, index: 0 })
      return true
    }
    if (n === 'escape') { onCancel(); return true }
    if (key.ctrl && n === 's') { start(); return true }
    if (step === 2) {
      // the notes: a box you type into at the cursor (arrows, Home/End, a click move it). Enter goes on, as on every
      // step; a new line is shift+enter, option+enter, or \ then enter (as in Claude Code)
      if (n === 'tab') { go(key.shift ? 1 : 3); return true }
      const moves: Record<string, NoteKey> = { left: 'left', right: 'right', up: 'up', down: 'down', home: 'home', end: 'end', backspace: 'backspace', delete: 'delete' }
      const move = moves[n] ?? (key.ctrl && n === 'a' ? 'home' : key.ctrl && n === 'e' ? 'end' : undefined)
      if (move) setNotes(x => editNote(x, { key: move }, noteWidth))
      else if (n === 'return' && (key.shift || key.meta || key.option)) setNotes(x => editNote(x, '\n', noteWidth))
      else if (n === 'return' && notes.text[notes.at - 1] === '\\') setNotes(x => editNote(editNote(x, { key: 'backspace' }, noteWidth), '\n', noteWidth))
      else if (n === 'return') { if (hasThree) go(3); else start() }
      else if (typed) setNotes(x => editNote(x, typed, noteWidth))
      return true
    }
    if (step === 3) {
      if (n === 'return') { start(); return true }
      if (n === 'tab' && key.shift && field === stepThree[0]) { go(2); return true }
      if ((n === 'tab' && !key.shift) || n === 'down') { move(1); return true }
      if ((n === 'tab' && key.shift) || n === 'up') { move(-1); return true }
      if (field.startsWith('var:')) {
        const v = envVars.find(x => `var:${x.name}` === field)
        if (!v) return true
        const cur = env[v.name] ?? ''
        const dd = n === 'right' ? 1 : n === 'left' ? -1 : 0
        if (v.choices?.length && dd) setVar(v.name, cycle(['', ...v.choices, ...(cur && !v.choices.includes(cur) ? [cur] : [])], cur, dd))
        else if (n === 'backspace') setVar(v.name, v.choices?.length ? '' : cur.slice(0, -1))
        else if (typed && typed !== ' ' && !v.choices?.length) setVar(v.name, cur + typed)
        return true
      }
      const k = field as 'email' | 'password' | 'license'
      if (n === 'backspace') setLogin(l => ({ ...l, [k]: l[k].slice(0, -1) }))
      else if (typed && typed !== ' ') setLogin(l => ({ ...l, [k]: l[k] + typed }))
      return true
    }
    if (n === 'return') { go(2); return true }
    if ((n === 'tab' && !key.shift) || n === 'down') { move(1); return true }
    if ((n === 'tab' && key.shift) || n === 'up') { move(-1); return true }
    const d = n === 'right' ? 1 : n === 'left' ? -1 : 0
    if (field === 'ticket') {
      if (n === 'backspace') setTicket(x => x.slice(0, -1))
      else if (typed && typed !== ' ') setTicket(x => x + typed)
      return true
    }
    if (field === 'task') {
      if (n === 'backspace') setTask(x => x.slice(0, -1))
      else if (typed) setTask(x => x + typed)
      return true
    }
    // base and patch: any key opens the list (a letter starts the search)
    if (field === 'base' || field === 'patch') { open(field, typed && typed !== ' ' ? typed : ''); return true }
    if (field === 'repos' && p) {
      if (d) setRepoAt(i => (i + d + p.repos.length) % p.repos.length)
      if (typed === ' ') { touch('repos'); const r = p.repos[repoAt]!; setRepos(rs => (rs.includes(r) ? rs.filter(x => x !== r) : p.repos.filter(x => x === r || rs.includes(x)))) }
      return true
    }
    if (field === 'dev' && (d || typed === ' ')) { setDev(x => !x); return true }
    if (field === 'headless' && (d || typed === ' ')) { setHeadless(x => !x); return true }
    if (!d) return true
    if (field === 'project') setProject(cycle(projects.map(x => x.key), project, d))
    if (field === 'kind') { touch('kind'); setKind(k => (k === 'bug' ? 'feature' : 'bug')) }
    if (field === 'device') setDevice(cycle(['none', ...(p?.devices ?? [])] as ('none' | 'android' | 'ios')[], device, d))
    if (field === 'model') setModel(cycle(MODELS, model, d))
    return true
  }
  useEffect(() => { bind(keys); return () => bind(null) })
  const paste = (text: string) => {
    const one = text.replace(/\r?\n/g, ' ').trim()
    if (picking) return setPicking(x => x && { ...x, query: x.query + one, index: 0 })
    if (step === 2) return setNotes(x => editNote(x, text, noteWidth))
    if (step === 3 && field.startsWith('var:')) { const name = field.slice(4); return setVar(name, (env[name] ?? '') + one.replace(/\s+/g, '')) }
    if (step === 3) { const k = field as 'email' | 'password' | 'license'; return setLogin(l => ({ ...l, [k]: l[k] + one.replace(/\s+/g, '') })) }
    if (field === 'ticket') return setTicket(x => x + one.replace(/\s+/g, ''))
    if (field === 'task') return setTask(x => x + text.trim())
    if (field === 'base' || field === 'patch') return open(field, one)
  }
  useEffect(() => { bindPaste?.(paste); return () => bindPaste?.(null) })

  const W = Math.min(96, width - 8)
  const radio = (opts: { v: string; label: string }[], cur: string, set: (v: string) => void) => opts.map(o => (
    <Click key={o.v || 'none'} on={() => set(o.v)}><text fg={o.v === cur ? C.text : C.secondary}>{`${o.v === cur ? '(•)' : '( )'} ${o.label}   `}</text></Click>
  ))
  const row = (f: Field, label: string, body: ReactNode, hint = '') => {
    const on = field === f
    return (
      <box key={f} flexDirection="row" backgroundColor={on ? C.selected : undefined} onMouseDown={() => setField(f)}>
        <text fg={on ? C.accent : C.muted}>{`${on ? '▌' : ' '} ${fit(label, 11)}`}</text>
        {body}
        {hint ? <text fg={C.faint}>{`   ${hint}`}</text> : null}
      </box>
    )
  }
  // a field chosen from a list: its value, and when focused how to open the list
  const pickRow = (f: 'base' | 'patch', label: string, value: string, hint: string) => row(f, label,
    <Click on={() => open(f)}><text><strong fg={value ? C.text : C.secondary}>{value || 'none'}</strong><span fg={C.muted}>{' ▾'}</span></text></Click>,
    field === f && !picking ? 'type to search · ↵ next' : hint)
  const picker = (f: 'base' | 'patch') => picking?.field === f ? (
    <box flexDirection="column" backgroundColor={C.selected} paddingLeft={13}>
      <text><span fg={C.accent}>{'› '}</span><span fg={C.text}>{picking.query}</span><span fg={C.accent}>▏</span><span fg={C.faint}>{`   ${shown.length} of ${(f === 'base' ? baseItems : patchItems).length} · ↑↓ choose · ↵ pick · esc close`}</span></text>
      {shown.slice(Math.max(0, picking.index - 6), Math.max(0, picking.index - 6) + 7).map(i => {
        const on = shown.indexOf(i) === picking.index
        return <Click key={i.value || 'none'} on={() => choose(f, i.value)}><text><span fg={on ? C.accent : C.faint}>{on ? '▸ ' : '  '}</span><span fg={on ? C.text : C.secondary}>{fit(i.label, 34)}</span><span fg={C.faint}>{i.hint ?? ''}</span></text></Click>
      })}
      {shown.length ? null : <text fg={C.muted}>{f === 'base' && picking.query.trim() ? `  nothing matches: ↵ uses "${picking.query.trim()}" as written` : '  nothing matches'}</text>}
    </box>
  ) : null

  const used = api.resources ? { agents: api.resources.holders.agents.length, builds: api.resources.holders.builds.length, devices: api.resources.holders.devices.length } : undefined
  const limits = api.resources?.limits
  const buildsFull = used && limits ? used.builds >= limits.builds : false
  const branch = !ticket.trim() && task.trim() ? `${kind === 'bug' ? 'fix' : 'feat'}/${slug(task.split('\n')[0]!) || '…'}` : ''
  const will = [
    `create ${branch || `a worktree${repos.length > 1 ? ' each' : ''}`} from ${base || 'the default base'} in ${repos.join(', ') || '…'}`,
    device !== 'none' ? `boot ${device === 'android' ? 'an android emulator' : 'an iOS simulator'} with its Metro` : '',
    dev ? `start the ${devRepos[0]} dev server` : '',
    patch ? `apply the ${patch} patch` : '',
    'then write the plan',
  ].filter(Boolean).join(', ')
  const fromTicket = (f: 'kind' | 'repos') => (t && !touched.has(f) ? 'from the ticket' : '')
  const blank = <text> </text>
  return (
    <box position="absolute" top={3} left={Math.max(2, Math.floor((width - W) / 2))} width={W} zIndex={20} flexDirection="column" border borderStyle="rounded" borderColor={C.faint} backgroundColor={C.panel} paddingTop={1} paddingBottom={1}>
      <text><strong>{'  New run'}</strong>{fixed && p ? <span fg={C.accent}>{` · ${p.name}`}</span> : null}<span fg={C.faint}>{'   a ticket to a draft PR'}</span></text>
      <box flexDirection="row">
        <text>{'  '}</text>
        {([[1, 'Run'], [2, 'Notes'], ...(hasThree ? [[3, threeLabel] as const] : [])] as const).map(([n, label]) => (
          <Click key={n} on={() => go(n)}><text>
            <span fg={step === n ? C.accent : C.muted}>{step === n ? `▸ ${n} ` : `  ${n} `}</span><span fg={step === n ? C.text : C.secondary}>{step === n ? <strong>{label}</strong> : label}</span>
            <span fg={C.faint}>{n === 2 && note.trim() ? ` · ${note.trim().split('\n').length} line${note.trim().split('\n').length === 1 ? '' : 's'}` : n === 3 && loginFields.some(k => login[k]) ? ` · ${loginFields.filter(k => login[k]).length} set` : ''}{'      '}</span>
          </text></Click>
        ))}
      </box>
      {step === 1 ? <>
      {blank}
      {fixed ? null : row('project', 'Project', <>{radio(projects.map(x => ({ v: x.key, label: x.key })), project, setProject)}</>, p ? `${p.name} · ${p.tracker === 'jira' ? 'Jira' : 'Azure DevOps'} · ${p.repos.length} repos` : 'no projects configured')}
      {row('ticket', 'Ticket', <text fg={C.text}><strong>{ticket}</strong>{field === 'ticket' ? <span fg={C.accent}>▏</span> : ''}{ticket ? '' : <span fg={C.faint}>{p?.tracker === 'jira' ? 'a key or its link · empty: describe a task' : 'a number or its link · empty: describe a task'}</span>}</text>,
        look.state === 'loading' ? 'looking it up…' : look.state === 'ok' && t ? `✓ ${t.type || t.kind}${t.board ? ` · ${t.board}` : ''}` : '')}
      {!ticket.trim() ? row('task', 'Task', <text fg={C.text}>{task.length > W - 18 ? `…${task.slice(-(W - 19))}` : task}{field === 'task' ? <span fg={C.accent}>▏</span> : ''}{task ? '' : <span fg={C.faint}>what to do: the plan works from it, its first words name the branch</span>}</text>) : null}
      {look.state === 'ok' && t ? <text>{'             '}<span fg={C.text}>{fit(t.title, W - 16)}</span></text> : null}
      {look.state === 'ok' && t ? <text fg={t.exists ? C.warning : C.muted}>{`             ${t.exists ? `${t.run} exists already` : [t.customer ? `customer ${t.customer}` : '', t.area ? `area ${t.area}` : '', t.platform ? t.platform : '', `${t.comments} comment${t.comments === 1 ? '' : 's'}`, t.tags.length ? `tags ${t.tags.join(', ')}` : ''].filter(Boolean).join(' · ')}`}</text> : null}
      {look.state === 'error' ? <text fg={C.danger}>{`             ✕ ${fit(look.error ?? '', W - 18)}`}</text> : null}
      {blank}
      {pickRow('base', 'Base', base.replace(/^origin\//, ''), base === ticketBase && !touched.has('base') ? "the ticket's release line" : base === suggested[0] ? 'the default' : '')}
      {picker('base')}
      {row('kind', 'Kind', <>{radio([{ v: 'bug', label: 'bug' }, { v: 'feature', label: 'feature' }], kind, v => { touch('kind'); setKind(v as 'bug' | 'feature') })}</>, fromTicket('kind') && `the ticket is a ${t!.type || t!.kind}`)}
      {row('repos', 'Repos', <>{(p?.repos ?? []).map((r, i) => (
        <Click key={r} on={() => { setField('repos'); setRepoAt(i); touch('repos'); setRepos(rs => (rs.includes(r) ? rs.filter(x => x !== r) : (p?.repos ?? []).filter(x => x === r || rs.includes(x)))) }}>
          <text fg={repos.includes(r) ? C.text : C.secondary} bg={field === 'repos' && i === repoAt ? C.faint : undefined}>{`[${repos.includes(r) ? 'x' : ' '}] ${r}   `}</text>
        </Click>
      ))}</>, t && p && suggestRepos(t, p.repoMatch ?? {}, p.repos).length && !touched.has('repos') ? 'from the ticket' : '')}
      {fields.includes('device') ? row('device', 'Device', <>{radio([{ v: 'none', label: 'none' }, ...(p?.devices ?? []).map(d => ({ v: d, label: d }))], device, v => setDevice(v as 'none'))}</>,
        device !== 'none' && used && limits ? `emulator + Metro, ${used.devices} of ${limits.devices} in use` : '') : null}
      {fields.includes('dev') ? row('dev', 'Dev server', <>{radio([{ v: '', label: 'none' }, { v: 'on', label: devRepos[0]! }], dev ? 'on' : '', v => setDev(!!v))}</>, dev ? 'its own port' : '') : null}
      {fields.includes('headless') ? row('headless', 'Window', <>{radio([{ v: 'on', label: 'headless' }, { v: '', label: 'shown' }], headless ? 'on' : '', v => setHeadless(!!v))}</>, headless ? 'seen in the browser page (b in the run)' : 'the emulator and browser windows open') : null}
      {fields.includes('patch') ? pickRow('patch', 'Patch', patch, patch && patch === ticketPatch && !touched.has('patch') ? `the ticket points at it (${t?.customer || t?.board})` : `${choices.length} customer patches`) : null}
      {fields.includes('patch') ? picker('patch') : null}
      {patch && check && !check.ok ? <text fg={C.warning} bg="#2A2416">{`             ⚠ ${fit(check.text || 'no patch for this base', W - 18)}`}</text> : null}
      {patch && check?.ok ? <text fg={C.success}>{`             ✓ ${fit(check.text, W - 18)}`}</text> : null}
      {row('model', 'Model', <>{radio(MODELS.map(m => ({ v: m, label: m })), model, setModel)}</>)}
      {blank}
      {wrap(will, W - 16).slice(0, 3).map((l, i) => <text key={i}>{'  '}<span fg={C.muted}>{i ? '          ' : 'Will      '}</span><span fg={C.secondary}>{l}</span></text>)}
      {used && limits ? <text>{'  '}<span fg={C.muted}>{'Slots     '}</span><span fg={buildsFull ? C.warning : C.secondary}>{`agents ${limits.agents - used.agents}/${limits.agents} free · builds ${used.builds}/${limits.builds}${buildsFull ? ' full → the install waits for a slot' : ''}`}</span></text> : null}
      </> : null}
      {step === 2 ? <>
        {blank}
        <text fg={C.muted}>{'  For the agent, as long as you like: how to test, which order, tenant or cloud, what not to touch.'}</text>
        <text fg={C.faint}>{'  It goes into the agent\'s brief for the whole run.'}</text>
        {blank}
        <box flexDirection="column" marginLeft={2} marginRight={2} backgroundColor={C.selected} paddingLeft={1} paddingRight={1} height={NOTE_ROWS + 2} paddingTop={1} onMouseDown={() => setNotes(x => ({ ...x, at: x.text.length }))}>
          {(() => {
            if (!note) return <text><span fg={C.accent}>▏</span><span fg={C.faint}>e.g. Test on order 700216740 in the qa cloud; the tablet layout too; leave the sync code alone.</span></text>
            // the rows around the cursor: the last ones while you type at the end
            const rs = noteRows(note, noteWidth), c = noteCursor(note, noteWidth, notes.at)
            const top = Math.max(c.row - NOTE_ROWS + 1, Math.min(c.row, Math.max(0, rs.length - NOTE_ROWS)))
            return rs.slice(top, top + NOTE_ROWS).map((r, i) => (
              <text key={top + i} fg={C.text} onMouseDown={e => { e.stopPropagation(); const col = e.x - (e.currentTarget?.x ?? e.x); setNotes(x => ({ ...x, at: noteAt(x.text, noteWidth, top + i, col) })) }}>
                {top + i !== c.row ? r.text || ' ' : <>{r.text.slice(0, c.col)}{c.col < r.text.length ? <span bg={C.accent} fg={C.panel}>{r.text[c.col]}</span> : <span fg={C.accent}>▏</span>}{r.text.slice(c.col + 1)}</>}
              </text>
            ))
          })()}
        </box>
        {blank}
      </> : null}
      {step === 3 ? <>
        {loginFields.length ? <>
        {blank}
        <text fg={C.muted}>{'  Test logins for the device, all optional.'}</text>
        <text fg={C.faint}>{'  Kept in a file only you can read; the agent is pointed at it, and ship refuses a change or PR that contains them.'}</text>
        {blank}
        {row('email', 'Email', <text fg={C.text}>{login.email}{field === 'email' ? <span fg={C.accent}>▏</span> : ''}{login.email ? '' : <span fg={C.faint}>the test user</span>}</text>)}
        {row('password', 'Password', <text fg={C.text}>{'•'.repeat(Math.min(login.password.length, 32))}{field === 'password' ? <span fg={C.accent}>▏</span> : ''}{login.password ? '' : <span fg={C.faint}>never shown</span>}</text>)}
        {p?.license ? row('license', 'License', <text fg={C.text}>{'•'.repeat(Math.min(login.license.length, 32))}{field === 'license' ? <span fg={C.accent}>▏</span> : ''}{login.license ? '' : <span fg={C.faint}>the app's license, if it asks for one</span>}</text>) : null}
        </> : null}
        {envVars.length ? <>
          {blank}
          <text fg={C.muted}>{"  The run's environment: where its app and browser point."}</text>
          {blank}
          {envVars.map(v => {
            const f = `var:${v.name}` as const, cur = env[v.name] ?? ''
            const follows = v.from ? (p?.vars ?? []).find(x => x.name === v.from) : undefined
            const empty = follows && env[follows.name] ? `follows ${follows.label ?? follows.name}: ${env[follows.name]}` : v.default ? `default: ${v.default}` : "the template's value"
            const hint = cur && look.data?.vars?.[v.name] === cur && !envTouched.has(v.name) ? 'from the ticket' : v.choices?.length ? '←→ choose' : ''
            return row(f, v.label ?? v.name, <text fg={C.text}>{cur}{field === f && !v.choices?.length ? <span fg={C.accent}>▏</span> : ''}{cur ? '' : <span fg={C.faint}>{empty}</span>}</text>, hint)
          })}
        </> : null}
        {blank}
      </> : null}
      {blank}
      {problem ? <text fg={C.danger}>{`  ${problem}`}</text> : null}
      <box flexDirection="row">
        <text>{'  '}</text>
        {step === 1 ? <Click on={() => go(2)}><box backgroundColor={C.accent}><text fg={C.panel}><strong>{' ↵ Next: Notes '}</strong></text></box></Click> : null}
        {step === 3 ? <Click on={start}><box backgroundColor={C.accent}><text fg={C.panel}><strong>{' ↵ Start run '}</strong></text></box></Click> : null}
        {step === 2 && hasThree ? <Click on={() => go(3)}><box backgroundColor={C.accent}><text fg={C.panel}><strong>{` ↵ Next: ${threeLabel} `}</strong></text></box></Click> : null}
        {step === 2 && !hasThree ? <Click on={start}><box backgroundColor={C.accent}><text fg={C.panel}><strong>{' ↵ Start run '}</strong></text></box></Click> : null}
        <text fg={C.muted}>{step === 1 ? '   ⇥ next field   ←→ choose   space toggle   ' : step === 2 ? '   ⇧↵ new line   ←→↑↓ or a click move   ⇧⇥ back   ' : '   ⇥ next field   ⇧⇥ back   '}</text>
        {step === 1 || (step === 2 && hasThree) ? <Click on={start}><text fg={C.muted}>{'ctrl+s start now   '}</text></Click> : null}
        <Click on={onCancel}><text fg={C.muted}>esc cancel</text></Click>
      </box>
    </box>
  )
}
