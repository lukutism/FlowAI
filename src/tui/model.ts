import type { Needs, RunState, Stage } from '../run.ts'
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
  key: 'a' | 'm' | 's' | '↵'; action: 'approve' | 'message' | 'ship' | 'open'
  tone: 'warning' | 'danger' | 'success' | 'accent'
}

const LABELS: Record<Needs['kind'], [label: string, key: AttentionItem['key'], action: AttentionItem['action'], tone: AttentionItem['tone']]> = {
  plan: ['Plan approval', 'a', 'approve', 'warning'],
  question: ['Agent question', 'm', 'message', 'warning'],
  blocked: ['Blocked', 'm', 'message', 'danger'],
  setup: ['Setup failed', 'm', 'message', 'danger'],
  verify: ['Verify stuck', 'm', 'message', 'danger'],
  review: ['Review cap', 'm', 'message', 'danger'],
  ship: ['Ready to ship', 's', 'ship', 'success'],
  pr: ['Draft PR', '↵', 'open', 'accent'],
  patch: ['Write-back checked', 's', 'ship', 'success'],
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
    const qs = n.kind === 'plan' ? (r.plan?.questions ?? []).map(q => `${q.id} ${q.text} (default: ${q.default})`).join(' · ') : ''
    const when = n.kind !== 'plan' ? '' : n.held || !n.deadline ? 'held for you' : n.deadline <= now ? 'defaults now' : `defaults in ${duration(n.deadline - now)}`
    return { run: r.id, ticket: r.ticket, title: r.title, project: r.project, line: line(r.base), label, key, action, tone, when,
      detail: n.kind === 'plan' ? qs || n.ask : n.kind === 'pr' ? r.pr?.url ?? n.ask : n.ask }
  })
}

export interface Row {
  run: string; ticket: string; title: string; project: string; line: string
  track: string; stage: string; status: string; tone: 'accent' | 'warning' | 'danger' | 'success' | 'muted'
  elapsed: string; tokens: string; next: string; mine: boolean
}

const CURRENT: Record<RunState['status'], string> = { running: '◎', waiting: '◌', 'needs-you': '◆', paused: '‖', blocked: '✕', failed: '✕', done: '●' }

export function track(r: RunState): string {
  if (r.stage === 'done') return '●'.repeat(STAGES.length)
  const i = STAGES.indexOf(r.stage)
  return STAGES.map((_, j) => (j < i ? '●' : j === i ? CURRENT[r.status] : '◌')).join('')
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

export function rows(runs: RunState[], now: number): Row[] {
  const live = runs.filter(r => r.status !== 'done').sort((a, b) => b.createdAt - a.createdAt)
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
