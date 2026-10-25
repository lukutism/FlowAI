import type { KeyEvent } from '@opentui/core'
import { useEffect, useState, type ReactNode } from 'react'
import type { Snapshot } from '../resources.ts'
import type { Command, ProjectSummary, Query } from '../service.ts'
import { C, wrap } from './detail.tsx'

/** what the form needs from the service connection */
export interface FormApi {
  projects?: ProjectSummary[]
  resources?: Snapshot
  query?<T>(q: Query): Promise<T>
}

export interface Lookup { run: string; exists: boolean; key: string; title: string; kind: 'bug' | 'feature'; type: string; url: string; board: string; customer: string; tags: string[]; comments: number; area?: string }

type Field = 'project' | 'ticket' | 'base' | 'kind' | 'repos' | 'device' | 'dev' | 'patch' | 'model'
const MODELS = ['default', 'opus', 'sonnet']

/** the base a ticket's release tag points at (3.18 → the newest patch/3.18.x), else none */
export function suggestBase(tags: string[], bases: string[]): string | undefined {
  const line = tags.map(t => /^(\d+\.\d+)$/.exec(t.trim())?.[1]).find(Boolean)
  return line ? bases.find(b => b.includes(`/${line}.`)) : undefined
}

/**
 * The customer patch a ticket points at: its customer (named on it, else in its board's name), and of that customer's
 * apps the one its area names, or the only one; none when it can't tell which app.
 */
export function suggestPatch(t: { customer: string; board: string; area?: string }, choices: string[]): string | undefined {
  const who = t.customer.toLowerCase()
  const mine = choices.filter(c => (who ? c.split('/')[0] === who : t.board.toLowerCase().includes(c.split('/')[0]!)))
  const area = (t.area ?? '').toLowerCase()
  return mine.find(c => area && area.includes(c.split('/')[1]!)) ?? (mine.length === 1 ? mine[0] : undefined)
}

const fit = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n))
function Click({ on, children }: { on: () => void; children: ReactNode }) { return <box onMouseDown={on}>{children}</box> }

/**
 * The new-run form: everything a run is started with on one panel, filled in from the ticket where it can be, checked
 * before it starts (the ticket exists, no run has it yet, the customer patch fits the base), with what will happen.
 */
export function NewRunForm({ api, width, project: initial, bind, onStart, onCancel }: {
  api: FormApi; width: number; project?: string
  bind: (keys: ((key: KeyEvent, typed: string) => boolean) | null) => void
  onStart: (c: Extract<Command, { cmd: 'start' }>) => void
  onCancel: () => void
}) {
  const projects = api.projects ?? []
  const [project, setProject] = useState(initial && projects.some(p => p.key === initial) ? initial : projects[0]?.key ?? '')
  const p = projects.find(x => x.key === project)
  const [ticket, setTicket] = useState('')
  const [look, setLook] = useState<{ state: 'idle' | 'loading' | 'ok' | 'error'; data?: Lookup; error?: string }>({ state: 'idle' })
  const [bases, setBases] = useState<Record<string, string[]>>({})
  const [base, setBase] = useState('')
  const [kind, setKind] = useState<'bug' | 'feature'>('bug')
  const [repos, setRepos] = useState<string[]>(p?.defaults ?? p?.repos.slice(0, 1) ?? [])
  const [repoAt, setRepoAt] = useState(0)
  const [device, setDevice] = useState<'none' | 'android' | 'ios'>('none')
  const [dev, setDev] = useState(false)
  const [choices, setChoices] = useState<string[]>([])
  const [patch, setPatch] = useState('')
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null)
  const [model, setModel] = useState('default')
  const [field, setField] = useState<Field>('ticket')
  const [problem, setProblem] = useState('')
  /** what you chose yourself since the last lookup: suggestions never overwrite it */
  const [touched, setTouched] = useState<Set<'base' | 'patch' | 'kind'>>(new Set())
  const touch = (f: 'base' | 'patch' | 'kind') => setTouched(t => new Set(t).add(f))

  // a project's own answers: its repos, bases and customer patches
  useEffect(() => {
    if (!p) return
    setRepos(p.defaults ?? p.repos.slice(0, 1)); setDevice('none'); setDev(false); setPatch(''); setRepoAt(0)
    void api.query?.<Record<string, string[]>>({ q: 'bases', project }).then(b => { setBases(b); setBase(b[(p.defaults ?? p.repos)[0]!]?.[0] ?? '') }).catch(() => setBases({}))
    void (p.patches.length ? api.query?.<string[]>({ q: 'patches', project }).then(setChoices).catch(() => setChoices([])) : setChoices([]))
  }, [project])

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
    if (look.state !== 'ok' || !d) return
    if (!touched.has('kind')) setKind(d.kind)
    const b = suggestBase(d.tags, bases[repos[0] ?? ''] ?? []); if (b && !touched.has('base')) setBase(b)
    const s = suggestPatch(d, choices); if (s && !touched.has('patch')) setPatch(s)
  }, [look, bases, choices])

  // whether the chosen patch fits the base
  useEffect(() => {
    if (!patch || !base || !api.query) { setCheck(null); return }
    let live = true
    void api.query<{ ok: boolean; text: string }>({ q: 'checkPatch', project, patch, base }).then(c => { if (live) setCheck(c) }).catch(() => {})
    return () => { live = false }
  }, [patch, base, project])

  const baseChoices = bases[repos[0] ?? ''] ?? (base ? [base] : [])
  const devRepos = (p?.devServers ?? []).filter(r => repos.includes(r))
  const fields: Field[] = ['project', 'ticket', 'base', 'kind', 'repos', ...(p?.devices.length ? ['device' as const] : []), ...(devRepos.length ? ['dev' as const] : []), ...(p?.patches.some(r => repos.includes(r)) && choices.length ? ['patch' as const] : []), 'model']
  const move = (d: number) => setField(f => fields[(fields.indexOf(f) + d + fields.length) % fields.length]!)
  const cycle = <T,>(list: T[], cur: T, d: number): T => list[(list.indexOf(cur) + d + list.length) % list.length] ?? cur

  const start = () => {
    if (!p) return setProblem('no project: add one in ~/.config/flow/projects')
    if (!ticket.trim()) { setField('ticket'); return setProblem('type the ticket first') }
    if (look.state === 'loading') return setProblem('still looking the ticket up')
    if (look.state === 'error') return setProblem(look.error ?? 'the ticket could not be read')
    if (look.data?.exists) return setProblem(`${look.data.run} exists already: open it from the runs`)
    if (!repos.length) { setField('repos'); return setProblem('choose at least one repo') }
    if (patch && check && !check.ok) { setField('patch'); return setProblem('the customer patch does not fit this base: choose another base or no patch') }
    onStart({ cmd: 'start', project, ticket: /^\d+$/.test(ticket) ? Number(ticket) : ticket, ...(base ? { base } : {}), kind, repos,
      ...(device !== 'none' ? { device } : {}), ...(dev ? { devServer: true } : {}), ...(patch ? { patch } : {}), ...(model !== 'default' ? { model } : {}) })
  }

  const keys = (key: KeyEvent, typed: string): boolean => {
    setProblem('')
    const n = key.name
    if (n === 'escape') { onCancel(); return true }
    if (n === 'return') { start(); return true }
    if ((n === 'tab' && !key.shift) || n === 'down') { move(1); return true }
    if ((n === 'tab' && key.shift) || n === 'up') { move(-1); return true }
    const d = n === 'right' ? 1 : n === 'left' ? -1 : 0
    if (field === 'ticket') {
      if (n === 'backspace') setTicket(t => t.slice(0, -1))
      else if (typed && typed !== ' ') setTicket(t => t + typed)
      return true
    }
    if (field === 'repos' && p) {
      if (d) setRepoAt(i => (i + d + p.repos.length) % p.repos.length)
      if (typed === ' ') { const r = p.repos[repoAt]!; setRepos(rs => (rs.includes(r) ? rs.filter(x => x !== r) : p.repos.filter(x => x === r || rs.includes(x)))) }
      return true
    }
    if (field === 'dev' && (d || typed === ' ')) { setDev(x => !x); return true }
    if (!d) return true
    if (field === 'project') setProject(cycle(projects.map(x => x.key), project, d))
    if (field === 'base') { touch('base'); setBase(cycle(baseChoices, base, d)) }
    if (field === 'kind') { touch('kind'); setKind(k => (k === 'bug' ? 'feature' : 'bug')) }
    if (field === 'device') setDevice(cycle(['none', ...(p?.devices ?? [])] as ('none' | 'android' | 'ios')[], device, d))
    if (field === 'patch') { touch('patch'); setPatch(cycle(['', ...choices], patch, d)) }
    if (field === 'model') setModel(cycle(MODELS, model, d))
    return true
  }
  useEffect(() => { bind(keys); return () => bind(null) })

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
  const used = api.resources ? { agents: api.resources.holders.agents.length, builds: api.resources.holders.builds.length, devices: api.resources.holders.devices.length } : undefined
  const limits = api.resources?.limits
  const buildsFull = used && limits ? used.builds >= limits.builds : false
  const t = look.data
  const will = [
    `create a worktree${repos.length > 1 ? ' each' : ''} from ${base || 'the default base'} in ${repos.join(', ') || '…'}`,
    device !== 'none' ? `boot ${device === 'android' ? 'an android emulator' : 'an iOS simulator'} with its Metro` : '',
    dev ? `start the ${devRepos[0]} dev server` : '',
    patch ? `apply the ${patch} patch` : '',
    'then write the plan',
  ].filter(Boolean).join(', ')
  const blank = <text> </text>
  return (
    <box position="absolute" top={3} left={Math.max(2, Math.floor((width - W) / 2))} width={W} zIndex={20} flexDirection="column" border borderStyle="rounded" borderColor={C.faint} backgroundColor={C.panel} paddingTop={1} paddingBottom={1}>
      <text><strong>{'  New run'}</strong><span fg={C.faint}>{'   a ticket to a draft PR'}</span></text>
      {blank}
      {row('project', 'Project', <>{radio(projects.map(x => ({ v: x.key, label: x.key })), project, setProject)}</>, p ? `${p.name} · ${p.tracker === 'jira' ? 'Jira' : 'Azure DevOps'} · ${p.repos.length} repos` : 'no projects configured')}
      {row('ticket', 'Ticket', <text fg={C.text}><strong>{ticket}</strong>{field === 'ticket' ? <span fg={C.accent}>▏</span> : ''}{ticket ? '' : <span fg={C.faint}>{p?.tracker === 'jira' ? 'a key, e.g. SGL-692' : 'a work item number'}</span>}</text>,
        look.state === 'loading' ? 'looking it up…' : look.state === 'ok' && t ? `✓ ${t.type || t.kind}${t.board ? ` · ${t.board}` : ''}` : look.state === 'error' ? '' : '')}
      {look.state === 'ok' && t ? <text>{'             '}<span fg={C.text}>{fit(t.title, W - 16)}</span></text> : null}
      {look.state === 'ok' && t ? <text fg={t.exists ? C.warning : C.muted}>{`             ${t.exists ? `${t.run} exists already` : [t.customer ? `customer ${t.customer}` : '', `${t.comments} comment${t.comments === 1 ? '' : 's'}`, t.tags.length ? `tags ${t.tags.join(', ')}` : ''].filter(Boolean).join(' · ')}`}</text> : null}
      {look.state === 'error' ? <text fg={C.danger}>{`             ✕ ${fit(look.error ?? '', W - 18)}`}</text> : null}
      {blank}
      {row('base', 'Base', <text><strong fg={C.text}>{base || '–'}</strong><span fg={C.muted}>{baseChoices.length > 1 ? ' ▾' : ''}</span></text>, t && suggestBase(t.tags, baseChoices) === base ? 'the ticket\'s release line' : base === baseChoices[0] ? 'the default' : '')}
      {field === 'base' && baseChoices.length > 1 ? (
        <box flexDirection="row" backgroundColor={C.selected}><text>{'             '}</text>{baseChoices.slice(0, 6).map(b => <Click key={b} on={() => { touch('base'); setBase(b) }}><text fg={b === base ? C.text : C.muted}>{`${b.replace(/^origin\//, '')}${b === base ? '◂' : ''}  `}</text></Click>)}</box>
      ) : null}
      {row('kind', 'Kind', <>{radio([{ v: 'bug', label: 'bug' }, { v: 'feature', label: 'feature' }], kind, v => { touch('kind'); setKind(v as 'bug' | 'feature') })}</>, t ? `the ticket is a ${t.type || t.kind}` : '')}
      {row('repos', 'Repos', <>{(p?.repos ?? []).map((r, i) => (
        <Click key={r} on={() => { setField('repos'); setRepoAt(i); setRepos(rs => (rs.includes(r) ? rs.filter(x => x !== r) : (p?.repos ?? []).filter(x => x === r || rs.includes(x)))) }}>
          <text fg={repos.includes(r) ? C.text : C.secondary} bg={field === 'repos' && i === repoAt ? C.faint : undefined}>{`[${repos.includes(r) ? 'x' : ' '}] ${r}   `}</text>
        </Click>
      ))}</>)}
      {fields.includes('device') ? row('device', 'Device', <>{radio([{ v: 'none', label: 'none' }, ...(p?.devices ?? []).map(d => ({ v: d, label: d }))], device, v => setDevice(v as 'none'))}</>,
        device !== 'none' && used && limits ? `emulator + Metro, ${used.devices} of ${limits.devices} in use` : '') : null}
      {fields.includes('dev') ? row('dev', 'Dev server', <>{radio([{ v: '', label: 'none' }, { v: 'on', label: devRepos[0]! }], dev ? 'on' : '', v => setDev(!!v))}</>, dev ? 'its own port' : '') : null}
      {fields.includes('patch') ? row('patch', 'Patch', <>{radio([...new Set(['', patch, t ? suggestPatch(t, choices) ?? '' : ''])].filter((v, i) => i === 0 || v).map(v => ({ v, label: v || 'none' })), patch, v => { touch('patch'); setPatch(v) })}</>,
        `${t && suggestPatch(t, choices) ? `the ticket names ${t.customer || t.board} · ` : ''}←→ all ${choices.length}`) : null}
      {patch && check && !check.ok ? <text fg={C.warning} bg="#2A2416">{`             ⚠ ${fit(check.text || 'no patch for this base', W - 18)}`}</text> : null}
      {patch && check?.ok ? <text fg={C.success}>{`             ✓ ${fit(check.text, W - 18)}`}</text> : null}
      {row('model', 'Model', <>{radio(MODELS.map(m => ({ v: m, label: m })), model, setModel)}</>)}
      {blank}
      {wrap(will, W - 16).slice(0, 3).map((l, i) => <text key={i}>{'  '}<span fg={C.muted}>{i ? '          ' : 'Will      '}</span><span fg={C.secondary}>{l}</span></text>)}
      {used && limits ? <text>{'  '}<span fg={C.muted}>{'Slots     '}</span><span fg={buildsFull ? C.warning : C.secondary}>{`agents ${limits.agents - used.agents}/${limits.agents} free · builds ${used.builds}/${limits.builds}${buildsFull ? ' full → the install waits for a slot' : ''}`}</span></text> : null}
      {blank}
      {problem ? <text fg={C.danger}>{`  ${problem}`}</text> : null}
      <box flexDirection="row">
        <text>{'  '}</text>
        <Click on={start}><box backgroundColor={C.accent}><text fg={C.panel}><strong>{' ↵ Start run '}</strong></text></box></Click>
        <text fg={C.muted}>{'   ⇥ next field   ←→ choose   space toggle   '}</text>
        <Click on={onCancel}><text fg={C.muted}>esc cancel</text></Click>
      </box>
    </box>
  )
}
