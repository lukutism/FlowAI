import type { Needs, RunEvent, RunState, Stage } from '../run.ts'
import type { Kind, Snapshot } from '../resources.ts'
import type { Windows } from '../usage.ts'

/** What the Runs screen shows, computed from run states: no terminal needed to test it. */

export const STAGES: Stage[] = ['setup', 'plan', 'build', 'verify', 'review', 'ship']

export const duration = (ms: number) => {
  const m = Math.floor(ms / 60_000)
  return m < 1 ? '<1m' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}
export const tokens = (n: number) => (!n ? '–' : n >= 1e6 ? `${(Math.round(n / 1e5) / 10).toFixed(1)}M` : `${Math.round(n / 1000)}k`)
/** origin/patch/3.18.41 → 3.18.41, origin/develop → develop */
export const line = (base: string) => base.replace(/^origin\//, '').replace(/^(patch|release|hotfix)\//, '')
export const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

export interface AttentionItem {
  run: string; ticket: string; title: string; project: string; line: string
  label: string; detail: string; when: string
  /** the key that acts on it, and what it does */
  key: 'a' | 'm' | 'S' | '↵'; action: 'approve' | 'message' | 'ship' | 'open'
  tone: 'warning' | 'danger' | 'success' | 'accent'
}

const LABELS: Record<Needs['kind'], [label: string, key: AttentionItem['key'], action: AttentionItem['action'], tone: AttentionItem['tone']]> = {
  plan: ['Plan approval', 'a', 'approve', 'warning'],
  question: ['Agent question', 'm', 'message', 'warning'],
  blocked: ['Blocked', 'm', 'message', 'danger'],
  setup: ['Setup failed', 'm', 'message', 'danger'],
  verify: ['Verify stuck', 'm', 'message', 'danger'],
  review: ['Review cap', 'm', 'message', 'danger'],
  ship: ['Ready to ship', 'S', 'ship', 'success'],
  pr: ['Draft PR', '↵', 'open', 'accent'],
  patch: ['Write-back checked', 'S', 'ship', 'success'],
}
const ORDER = ['plan', 'question', 'blocked', 'setup', 'verify', 'review', 'ship', 'patch', 'pr']

export function attention(runs: RunState[], now: number): AttentionItem[] {
  const items = runs.filter(r => r.needs && r.status !== 'done')
  const rank = (r: RunState) => {
    const n = r.needs!
    if (n.kind === 'plan') return n.held || !n.deadline ? [0, 0] : [1, n.deadline]
    return [2 + ORDER.indexOf(n.kind), -r.updatedAt]
  }
  items.sort((a, b) => { const [x1, y1] = rank(a), [x2, y2] = rank(b); return x1! - x2! || y1! - y2! })
  return items.map(r => {
    const n = r.needs!
    const [label, key, action, tone] = LABELS[n.kind]
    const count = r.plan?.questions.length ?? 0
    const plan = `${n.held ? 'Decides whether behaviour changes: ' : ''}${r.plan?.summary ?? ''} · ${count} open question${count === 1 ? '' : 's'}`
    const when = n.kind !== 'plan' ? '' : n.held || !n.deadline ? 'held for you' : n.deadline <= now ? 'defaults now' : `defaults in ${duration(n.deadline - now)}`
    return { run: r.id, ticket: r.ticket, title: r.title, project: r.project, line: line(r.base), label, key, action, tone, when,
      detail: n.kind === 'plan' ? plan : n.kind === 'question' ? `Asks: "${n.ask}"` : n.kind === 'pr' ? r.pr?.url ?? n.ask : n.ask }
  })
}

export interface Row {
  run: string; ticket: string; title: string; project: string; line: string
  track: string; stage: string; status: string; tone: 'accent' | 'warning' | 'danger' | 'success' | 'muted'
  elapsed: string; tokens: string; next: string; mine: boolean
}

const CURRENT: Record<RunState['status'], string> = { running: '◎', waiting: '◌', 'needs-you': '◆', paused: '‖', blocked: '✕', failed: '✕', done: '●' }

/** done stages joined by lines, the current one by its status, the ones to come dotted: ●─●─◎╌◌╌◌ */
export function track(r: RunState): string {
  if (r.stage === 'done') return `${'●─'.repeat(STAGES.length - 1)}●`
  const i = STAGES.indexOf(r.stage)
  return `${'●─'.repeat(i)}${CURRENT[r.status]}${'╌◌'.repeat(STAGES.length - 1 - i)}`
}

function statusWord(r: RunState): string {
  const loops = r.loops.review > 0 && (r.stage === 'review' || r.stage === 'build') && !r.loops.verify ? ` · review ×${r.loops.review}` : r.loops.verify > 0 ? ` · verify ×${r.loops.verify}` : ''
  if (r.status === 'paused') return `paused${r.pausedUntil ? ` until ${hhmm(r.pausedUntil)}` : ''}`
  if (r.status === 'waiting') return 'waiting'
  const words: Record<string, string> = { plan: 'approval', question: 'question', ship: 'verified', pr: 'draft PR', patch: 'write-back checked' }
  if (r.status === 'needs-you') return `${words[r.needs?.kind ?? ''] ?? r.needs?.kind ?? 'needs you'}${loops}`
  if (r.status === 'running' && r.stage === 'build' && r.loops.verify > 0) return `fixing${loops}`
  return `${r.status}${loops}`
}

function next(r: RunState): { text: string; mine: boolean } {
  const n = r.needs
  if (n) return { mine: true, text: { plan: 'approve plan', question: 'answer the agent', blocked: 'message the agent', setup: 'check setup', verify: 'message the agent', review: 'decide on review', ship: r.patch ? 'check the write-back' : 'ship', pr: `review PR #${r.pr?.number ?? ''}`, patch: 'write the patch back' }[n.kind] }
  if (r.status === 'waiting') return { mine: false, text: `waits for ${r.waitingFor ?? 'a slot'}` }
  if (r.status === 'paused') return { mine: false, text: 'resumes by itself' }
  if (r.status === 'done') return { mine: false, text: r.pr ? `PR #${r.pr.number}` : r.patch ? 'patch written back' : 'done' }
  return { mine: false, text: { setup: 'setting up', plan: 'planning', build: 'building', verify: 'verifying', review: 'in review', ship: 'shipping', done: 'done' }[r.stage] }
}

const TONE: Record<RunState['status'], Row['tone']> = { running: 'accent', waiting: 'muted', 'needs-you': 'warning', paused: 'muted', blocked: 'danger', failed: 'danger', done: 'success' }

export const SORTS = ['newest', 'oldest', 'active', 'tokens'] as const
export type Sort = (typeof SORTS)[number]
const ORDERS: Record<Sort, (a: RunState, b: RunState) => number> = {
  newest: (a, b) => b.createdAt - a.createdAt, oldest: (a, b) => a.createdAt - b.createdAt,
  active: (a, b) => b.updatedAt - a.updatedAt, tokens: (a, b) => b.tokens - a.tokens,
}

/** live runs first, in the chosen order; done runs after them, the latest first */
export function rows(runs: RunState[], now: number, sort: Sort = 'newest'): Row[] {
  const live = runs.filter(r => r.status !== 'done').sort(ORDERS[sort])
  const done = runs.filter(r => r.status === 'done').sort((a, b) => b.updatedAt - a.updatedAt)
  return [...live, ...done].map(r => {
    const n = next(r)
    return { run: r.id, ticket: r.ticket, title: r.title, project: r.project, line: line(r.base), track: track(r), stage: r.stage, status: statusWord(r), tone: TONE[r.status],
      elapsed: duration((r.status === 'done' ? r.updatedAt : now) - r.createdAt), tokens: tokens(r.tokens), next: n.text, mine: n.mine }
  })
}

export function header(runs: RunState[], w: Windows, now: number) {
  const pct = (x?: { utilization: number }) => (x ? `${Math.round(x.utilization * 100)}%` : '–')
  const reset = (x?: { resetsAt: number }) => (x && x.resetsAt * 1000 > now ? hhmm(x.resetsAt * 1000) : '')
  return {
    active: runs.filter(r => r.status !== 'done').length,
    needYou: runs.filter(r => r.status === 'needs-you' || r.status === 'blocked' || r.status === 'failed').length,
    waiting: runs.filter(r => r.status === 'waiting' || r.status === 'paused').length,
    fiveHour: pct(w.fiveHour), fiveHourReset: reset(w.fiveHour), week: pct(w.week),
  }
}

const startOfDay = (now: number) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime() }
const hiddenDone = (r: RunState, now: number) => r.status === 'done' && r.updatedAt < startOfDay(now)

/**
 * The filter: project:<key>, status:<status or what it needs>, stage:<stage>, and any other words matched against
 * the ticket, title and run. Done runs from before today are left out unless the filter asks for status:done.
 */
export function filterRuns(runs: RunState[], q: string, now = Date.now()): RunState[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const field = (k: string) => words.find(w => w.startsWith(`${k}:`))?.slice(k.length + 1)
  const project = field('project'), status = field('status'), stage = field('stage')
  const text = words.filter(w => !/^(project|status|stage):/.test(w))
  return runs.filter(r => (status === 'done' || !hiddenDone(r, now))
    && (!project || r.project.toLowerCase() === project)
    && (!status || r.status === status || r.needs?.kind === status)
    && (!stage || r.stage === stage)
    && text.every(w => `${r.id} ${r.ticket} ${r.title}`.toLowerCase().includes(w)))
}

export function footer(all: RunState[], shown: RunState[], q: string, now = Date.now()): string {
  if (q.trim()) return `${shown.length} of ${all.length} runs match`
  const hidden = all.filter(r => hiddenDone(r, now)).length
  return `${shown.length} of ${all.length} runs${hidden ? ` · ${hidden} done before today hidden` : ''}`
}

export type Grouped = { kind: 'group'; stage: Stage; count: number; tokens: string; collapsed: boolean } | { kind: 'row'; row: Row }

/** the table grouped by stage, in stage order; a collapsed group shows only its header */
export function groupRows(list: Row[], runs: RunState[], collapsed: Set<string>): Grouped[] {
  const out: Grouped[] = []
  for (const stage of [...STAGES, 'done' as const]) {
    const inStage = list.filter(r => r.stage === stage)
    if (!inStage.length) continue
    const sum = runs.filter(r => inStage.some(x => x.run === r.id)).reduce((n, r) => n + r.tokens, 0)
    out.push({ kind: 'group', stage, count: inStage.length, tokens: tokens(sum), collapsed: collapsed.has(stage) })
    if (!collapsed.has(stage)) out.push(...inStage.map(row => ({ kind: 'row' as const, row })))
  }
  return out
}

export interface Bar { kind: Kind; label: string; used: boolean[]; text: string; full: boolean; holders: string[]; waiting: string[] }

/** each kind of slot as one segment per slot, the used ones filled */
export function resourceBars(r: Snapshot): Bar[] {
  const labels: Record<Kind, string> = { agents: 'Agents', builds: 'Builds', devices: 'Devices' }
  return (['agents', 'builds', 'devices'] as Kind[]).map(kind => {
    const held = r.holders[kind], limit = r.limits[kind], full = held.length >= limit
    return { kind, label: labels[kind], used: Array.from({ length: limit }, (_, i) => i < held.length), text: `${held.length}/${limit} ${full ? 'full' : 'in use'}`, full,
      holders: held, waiting: r.waiting.filter(w => w.kind === kind).map(w => w.run) }
  })
}

/** an event in words, and the stage it belongs to ('' for ones that belong to none) */
export function describeEvent(e: RunEvent): { stage: Stage | ''; text: string } {
  switch (e.type) {
    case 'run.created': return { stage: 'setup', text: `started from ${line(e.base)}` }
    case 'setup.done': return { stage: 'setup', text: 'worktrees ready' }
    case 'setup.failed': return { stage: 'setup', text: `setup failed: ${e.reason}` }
    case 'device.ready': return { stage: 'setup', text: `device ${e.platform} ${e.id}, Metro :${e.metroPort}` }
    case 'device.released': return { stage: '', text: 'device stopped' }
    case 'devserver.ready': return { stage: 'setup', text: `dev server ${e.repo} at ${e.url}` }
    case 'devserver.stopped': return { stage: '', text: 'dev server stopped' }
    case 'patch.applied': return { stage: 'setup', text: `customer patch ${e.customer}/${e.app}: ${e.summary}` }
    case 'plan.submitted': return { stage: 'plan', text: e.questions.length ? `plan ready, ${e.questions.length} question${e.questions.length > 1 ? 's' : ''}` : 'plan ready, no questions' }
    case 'plan.decided': return { stage: 'plan', text: e.by === 'human' ? 'approved by you' : 'defaults taken at the deadline' }
    case 'agent.asked': return { stage: '', text: `asks: ${e.question}` }
    case 'human.message': return { stage: '', text: `you: ${e.text}` }
    case 'build.done': return { stage: 'build', text: 'change made' }
    case 'verify.result': return { stage: 'verify', text: e.ok ? 'no new findings' : `${e.newFindings.length} new finding${e.newFindings.length === 1 ? '' : 's'}` }
    case 'review.result': return { stage: 'review', text: e.findings ? `${e.findings} finding${e.findings === 1 ? '' : 's'} to fix` : 'nothing found' }
    case 'review.skipped': return { stage: 'review', text: `skipped: ${e.reason}` }
    case 'pr.opened': return { stage: 'ship', text: `draft PR #${e.number} opened${e.repo ? ` (${e.repo})` : ''}` }
    case 'patch.checked': return { stage: 'ship', text: 'write-back dry run done' }
    case 'patch.written': return { stage: 'ship', text: 'patch written back' }
    case 'run.blocked': return { stage: '', text: `blocked: ${e.reason}` }
    case 'run.waiting': return { stage: '', text: `waits for ${e.resource}` }
    case 'run.paused': return { stage: '', text: `paused (${e.window}) until ${hhmm(e.until)}` }
    case 'run.resumed': return { stage: '', text: 'resumed' }
    case 'run.done': return { stage: '', text: 'done' }
    case 'session.started': return { stage: '', text: 'agent session started' }
    case 'session.compacted': return { stage: '', text: `context compacted (${tokens(e.before)} → ${tokens(e.after)})` }
    case 'tokens.used': return { stage: '', text: `${tokens(e.tokens)} tokens` }
    case 'tool.denied': return { stage: '', text: `refused ${e.tool}: ${e.detail}` }
  }
}

/** the Activity feed: a run's events (or all runs'), newest first, without the token counts */
export function activity(events: RunEvent[], run?: string): { at: string; run: string; stage: string; text: string; actor: RunEvent['actor'] }[] {
  return events.filter(e => e.type !== 'tokens.used' && (!run || e.run === run)).reverse()
    .map(e => ({ at: hhmm(e.at), run: e.run, actor: e.actor, ...describeEvent(e) }))
}

const OUTCOMES = new Set(['pr.opened', 'patch.written', 'setup.failed', 'run.blocked', 'plan.decided', 'review.result'])

/** the latest outcome worth a line at the bottom, and how long ago */
export function lastMessage(events: RunEvent[], now: number): string {
  const e = [...events].reverse().find(x => OUTCOMES.has(x.type))
  if (!e) return ''
  const ago = `${duration(now - e.at)} ago`
  const text = e.type === 'pr.opened' ? `✓ ${e.run} shipped: draft PR #${e.number}` : e.type === 'patch.written' ? `✓ ${e.run}: patch written back`
    : e.type === 'setup.failed' ? `✕ ${e.run} setup failed: ${e.reason}` : e.type === 'run.blocked' ? `✕ ${e.run} blocked: ${e.reason}`
    : e.type === 'plan.decided' ? `✓ ${e.run}: plan ${e.by === 'human' ? 'approved by you' : 'took the defaults'}` : `${e.run}: ${describeEvent(e).text}`
  return `${text} · ${ago}`
}

/** letters of the query in order, gaps allowed, any case (the palette) */
export function match(q: string, text: string): boolean {
  let i = 0
  const t = text.toLowerCase()
  for (const c of q.toLowerCase().replace(/\s+/g, '')) { i = t.indexOf(c, i); if (i < 0) return false; i++ }
  return true
}

/**
 * The responsive rules: 120 columns and wider show everything; 80–99 drop the project and token columns, show the
 * stage as its label, one line per attention item, one Resources line, no message line, and tab numbers only;
 * below 80×24 a message replaces the screen. Short terminals lose table rows first, then the bottom panes.
 */
export function layout(width: number, height: number, attentionItems = 0) {
  if (width < 80 || height < 24) return { tooSmall: true as const, text: `Flow needs at least 80×24 (now ${width}×${height})` }
  const wide = width >= 100
  const att = Math.min(attentionItems, 3)
  const attLines = 1 + Math.max(1, att * (wide ? 2 : 1)) + (attentionItems > 3 ? 1 : 0)
  const fixed = 3 + attLines + 1 + 3 + 1 + (wide ? 2 : 1) + 1
  const bottomLines = wide ? 7 : 2
  const MIN_TABLE = 8
  const bottom = height - fixed - bottomLines >= MIN_TABLE
  return {
    tooSmall: false as const, text: '', project: wide, tokens: wide, track: wide, twoLineAttention: wide, split: wide, message: wide, tabNames: wide,
    attentionShown: att, bottom, tableRows: Math.max(1, height - fixed - (bottom ? bottomLines : 0)),
  }
}
