/**
 * A run: one ticket taken from intake to a draft PR. Its state is a fold over its events (apply), so every
 * transition is recorded with who caused it: the human, the agent, or the engine.
 */

export type Stage = 'setup' | 'plan' | 'build' | 'verify' | 'review' | 'ship' | 'done'
export type Status = 'running' | 'waiting' | 'needs-you' | 'paused' | 'blocked' | 'failed' | 'done'
export type Actor = 'human' | 'agent' | 'engine'

export interface Question { id: string; text: string; default: string; held: boolean }

export type EventBody =
  | { type: 'run.created'; ticket: string; title: string; project: string; base: string }
  | { type: 'setup.done' }
  | { type: 'setup.failed'; reason: string }
  | { type: 'plan.submitted'; summary: string; questions: Question[]; deadline?: number }
  | { type: 'plan.decided'; by: 'human' | 'deadline'; answers: Record<string, string> }
  | { type: 'agent.asked'; question: string }
  /** the agent found no change is needed (resolution.md): you confirm with done, or a message carries it on */
  | { type: 'run.resolved'; summary: string; text: string }
  | { type: 'human.message'; text: string }
  /** reason: why the engine sent a change back to verify (it moved after it was verified) */
  | { type: 'build.done'; reason?: string }
  /** tree: what was verified (the worktrees' content), so a later change is noticed */
  | { type: 'verify.result'; ok: boolean; newFindings: string[]; tree?: string }
  | { type: 'review.result'; findings: number }
  /** the project runs no reviewer yet: the run goes from verify to ship */
  | { type: 'review.skipped'; reason: string }
  | { type: 'pr.opened'; url: string; number: number; repo?: string }
  /** a ship that broke off: the gate stays, saying what failed (shipping again carries on) */
  | { type: 'ship.failed'; reason: string }
  /** a further change pushed to a draft PR that was open already */
  | { type: 'pr.updated'; number: number; repo?: string }
  /** after a message at a gate the change is as it was verified: the gate is back */
  | { type: 'run.ready' }
  | { type: 'run.blocked'; reason: string }
  | { type: 'run.waiting'; resource: string }
  | { type: 'run.paused'; window: string; until: number }
  | { type: 'run.resumed' }
  /** reason: when the engine saw it finish (its PR merged or closed on the host) */
  | { type: 'run.done'; reason?: string }
  /** the run's worktrees and branch removed, its folder archived: gone from the lists; its id can start again */
  | { type: 'run.removed' }
  | { type: 'session.started'; session: string }
  | { type: 'session.compacted'; before: number; after: number }
  /** tokens: the new work (input, output, cache writes); cached: what was read back from the prompt cache */
  | { type: 'tokens.used'; tokens: number; cached?: number }
  /** the guard (PreToolUse hook) refused a tool call; kept for the ledger, the run goes on */
  | { type: 'tool.denied'; tool: string; detail: string }
  /** the run's own device is booted, its app installed, its Metro answering */
  | { type: 'device.ready'; platform: 'android' | 'ios'; id: string; metroPort: number }
  | { type: 'device.released' }
  /** the run's own dev server is listening */
  | { type: 'devserver.ready'; repo: string; port: number; url: string }
  | { type: 'devserver.stopped' }
  /** the customer's patch, applied as a local commit (never pushed) so verify and review see only the fix */
  | { type: 'patch.applied'; customer: string; app: string; summary: string; commit: string }
  /** ship of a patch run: the write-back's dry run */
  | { type: 'patch.checked'; report: string }
  | { type: 'patch.written'; report: string }

export type RunEvent = EventBody & { seq: number; at: number; run: string; actor: Actor }
export type EventType = EventBody["type"]

export interface Needs { kind: 'plan' | 'question' | 'blocked' | 'verify' | 'review' | 'setup' | 'ship' | 'pr' | 'patch' | 'resolution'; ask: string; held?: boolean; deadline?: number }

export interface RunState {
  id: string; ticket: string; title: string; project: string; base: string
  stage: Stage; status: Status; needs?: Needs
  plan?: { summary: string; questions: Question[]; answers?: Record<string, string>; decidedBy?: 'human' | 'deadline' }
  /** verify: red runs in a row; verifyRuns: all runs; review: review runs that found something */
  loops: { verify: number; verifyRuns: number; review: number }
  /** the new work in tokens, and (apart) what was read back from the cache: far cheaper, but counted once per call */
  tokens: number; cached?: number; compactions: number; session?: string
  pr?: { url: string; number: number }
  /** one draft PR per repo the run changed */
  prs?: { url: string; number: number; repo?: string }[]
  waitingFor?: string; pausedUntil?: number
  device?: { platform: 'android' | 'ios'; id: string; metroPort: number }
  patch?: { customer: string; app: string; commit: string }
  devServer?: { repo: string; port: number; url: string }
  /** the content the last verify saw */
  verifiedTree?: string
  removed?: boolean
  createdAt: number; updatedAt: number
}

export interface Rules { maxRedVerifies: number; maxReviews: number }
export const DEFAULT_RULES: Rules = { maxRedVerifies: 3, maxReviews: 3 }

export class TransitionError extends Error {}

/** verified (and reviewed): publishing is the human's step (flow ship), like merging */
const READY = { status: 'needs-you' as const, needs: { kind: 'ship' as const, ask: 'verified: publish the draft PR with flow ship' } }

const prAsk = (prs: { number: number }[]) => (prs.length > 1 ? `review draft PRs ${prs.map(p => `#${p.number}`).join(', ')}` : `review draft PR #${prs[0]?.number}`)

const need = (s: RunState, stage: Stage, e: RunEvent) => {
  if (s.stage !== stage) throw new TransitionError(`${e.type} needs the run in ${stage}, it is in ${s.stage}`)
}
const go = (s: RunState, e: RunEvent, patch: Partial<RunState>): RunState => {
  const out: RunState = { ...s, ...patch, updatedAt: e.at }
  for (const k of ['needs', 'waitingFor', 'pausedUntil', 'device', 'devServer'] as const) if (k in patch && patch[k] === undefined) delete out[k]
  return out
}

export function apply(s: RunState | undefined, e: RunEvent, rules: Rules = DEFAULT_RULES): RunState {
  if (e.type === 'run.created') {
    if (s && !s.removed) throw new TransitionError(`run ${e.run} exists already`)
    return { id: e.run, ticket: e.ticket, title: e.title, project: e.project, base: e.base, stage: 'setup', status: 'running',
      loops: { verify: 0, verifyRuns: 0, review: 0 }, tokens: 0, compactions: 0, createdAt: e.at, updatedAt: e.at }
  }
  if (!s) throw new TransitionError(`${e.type} for run ${e.run}, which was never created`)
  if (s.removed) throw new TransitionError(`${e.type} for run ${e.run}, which was removed`)
  const running = { status: 'running' as const, needs: undefined, waitingFor: undefined, pausedUntil: undefined }
  switch (e.type) {
    case 'setup.done': need(s, 'setup', e); return go(s, e, { stage: 'plan', ...running })
    case 'setup.failed': need(s, 'setup', e); return go(s, e, { status: 'failed', needs: { kind: 'setup', ask: e.reason } })
    case 'plan.submitted': {
      need(s, 'plan', e)
      const plan = { summary: e.summary, questions: e.questions }
      if (!e.questions.length) return go(s, e, { stage: 'build', plan, ...running })
      const held = e.questions.some(q => q.held)
      const ask = `${e.questions.length} open question${e.questions.length > 1 ? 's' : ''}`
      return go(s, e, { plan, status: 'needs-you', needs: held || !e.deadline ? { kind: 'plan', ask, held } : { kind: 'plan', ask, held, deadline: e.deadline } })
    }
    case 'plan.decided': {
      if (s.needs?.kind !== 'plan' || !s.plan) throw new TransitionError('no plan is waiting for a decision')
      if (e.by === 'deadline' && s.needs.held) throw new TransitionError('a held question is decided by the human only')
      return go(s, e, { stage: 'build', plan: { ...s.plan, answers: e.answers, decidedBy: e.by }, ...running })
    }
    case 'build.done':
      // from build; or from a later stage when a message changed the code after it was verified
      if (!['build', 'verify', 'review', 'ship'].includes(s.stage)) need(s, 'build', e)
      return go(s, e, { stage: 'verify', ...running })
    case 'verify.result': {
      need(s, 'verify', e)
      const verifyRuns = s.loops.verifyRuns + 1
      if (e.tree) s = { ...s, verifiedTree: e.tree }
      if (e.ok) return go(s, e, { stage: 'review', loops: { ...s.loops, verify: 0, verifyRuns }, ...running })
      const verify = s.loops.verify + 1
      const loops = { ...s.loops, verify, verifyRuns }
      if (verify >= rules.maxRedVerifies) return go(s, e, { loops, status: 'needs-you', needs: { kind: 'verify', ask: `verify red ${verify} times in a row` } })
      return go(s, e, { stage: 'build', loops, ...running })
    }
    case 'review.result': {
      need(s, 'review', e)
      if (!e.findings) return go(s, e, { stage: 'ship', ...READY })
      const loops = { ...s.loops, review: s.loops.review + 1 }
      if (loops.review >= rules.maxReviews) return go(s, e, { loops, status: 'needs-you', needs: { kind: 'review', ask: `${e.findings} findings after ${loops.review} reviews` } })
      return go(s, e, { stage: 'build', loops, ...running })
    }
    case 'review.skipped': need(s, 'review', e); return go(s, e, { stage: 'ship', ...READY })
    case 'pr.opened': {
      need(s, 'ship', e)
      const prs = [...(s.prs ?? []), { url: e.url, number: e.number, ...(e.repo ? { repo: e.repo } : {}) }]
      return go(s, e, { pr: s.pr ?? { url: e.url, number: e.number }, prs, status: 'needs-you', needs: { kind: 'pr', ask: prAsk(prs) } })
    }
    case 'run.done': return go(s, e, { stage: 'done', status: 'done', needs: undefined, waitingFor: undefined, pausedUntil: undefined })
    case 'run.removed': return go(s, e, { removed: true, needs: undefined, waitingFor: undefined, pausedUntil: undefined })
    case 'agent.asked': return go(s, e, { status: 'needs-you', needs: { kind: 'question', ask: e.question } })
    case 'run.resolved': return go(s, e, { status: 'needs-you', needs: { kind: 'resolution', ask: `no change needed: ${e.summary}` } })
    case 'human.message':
      // a message sends the run on from wherever it stopped (a question, a block, a gate, a cap); flow puts the gate
      // back once the agent's turn is done. A failed setup and a finished run stay as they are.
      if (s.status === 'failed' || s.status === 'done') return go(s, e, {})
      if (s.status !== 'needs-you' && s.status !== 'blocked') return go(s, e, {})
      return go(s, e, { ...running, loops: { ...s.loops, ...(s.needs?.kind === 'verify' ? { verify: 0 } : {}), ...(s.needs?.kind === 'review' ? { review: 0 } : {}) } })
    case 'run.ready': need(s, 'ship', e); return go(s, e, s.prs?.length ? { status: 'needs-you', needs: { kind: 'pr', ask: prAsk(s.prs) } } : READY)
    case 'ship.failed': need(s, 'ship', e); return go(s, e, { status: 'needs-you', needs: { kind: s.needs?.kind === 'patch' || s.needs?.kind === 'pr' ? s.needs.kind : 'ship', ask: `ship failed: ${e.reason}; ship again to carry on` } })
    case 'pr.updated': need(s, 'ship', e); return go(s, e, { status: 'needs-you', needs: { kind: 'pr', ask: prAsk(s.prs ?? [{ url: '', number: e.number }]) } })
    case 'run.blocked': return go(s, e, { status: 'blocked', needs: { kind: 'blocked', ask: e.reason } })
    case 'run.waiting': return go(s, e, { status: 'waiting', waitingFor: e.resource })
    case 'run.paused': return go(s, e, { status: 'paused', pausedUntil: e.until })
    case 'run.resumed': return go(s, e, { status: s.needs ? (s.needs.kind === 'blocked' ? 'blocked' : 'needs-you') : 'running', waitingFor: undefined, pausedUntil: undefined })
    case 'session.started': return go(s, e, { session: e.session })
    case 'session.compacted': return go(s, e, { compactions: s.compactions + 1 })
    case 'tokens.used': return go(s, e, { tokens: s.tokens + e.tokens, ...(e.cached ? { cached: (s.cached ?? 0) + e.cached } : {}) })
    case 'tool.denied': return go(s, e, {})
    // at setup; later when the device is restarted
    case 'device.ready': if (s.stage === 'done') need(s, 'setup', e); return go(s, e, { device: { platform: e.platform, id: e.id, metroPort: e.metroPort } })
    case 'device.released': return go(s, e, { device: undefined })
    case 'devserver.ready': need(s, 'setup', e); return go(s, e, { devServer: { repo: e.repo, port: e.port, url: e.url } })
    case 'devserver.stopped': return go(s, e, { devServer: undefined })
    case 'patch.applied': need(s, 'setup', e); return go(s, e, { patch: { customer: e.customer, app: e.app, commit: e.commit } })
    case 'patch.checked':
      if (s.needs?.kind !== 'ship' || !s.patch) throw new TransitionError('patch.checked needs a verified patch run')
      return go(s, e, { status: 'needs-you', needs: { kind: 'patch', ask: 'write-back dry run in patch-report.txt: ship again to write the patch back' } })
    case 'patch.written':
      if (s.needs?.kind !== 'patch') throw new TransitionError('patch.written needs a checked write-back')
      return go(s, e, { stage: 'done', status: 'done', needs: undefined })
  }
}

export function fold(events: RunEvent[], rules: Rules = DEFAULT_RULES): RunState {
  const s = events.reduce<RunState | undefined>((acc, e) => apply(acc, e, rules), undefined)
  if (!s) throw new TransitionError('no events')
  return s
}
