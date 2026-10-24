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
  | { type: 'human.message'; text: string }
  | { type: 'build.done' }
  | { type: 'verify.result'; ok: boolean; newFindings: string[] }
  | { type: 'review.result'; findings: number }
  | { type: 'pr.opened'; url: string; number: number }
  | { type: 'run.blocked'; reason: string }
  | { type: 'run.waiting'; resource: string }
  | { type: 'run.paused'; window: string; until: number }
  | { type: 'run.resumed' }
  | { type: 'run.done' }
  | { type: 'session.started'; session: string }
  | { type: 'session.compacted'; before: number; after: number }
  | { type: 'tokens.used'; tokens: number }
  /** the guard (PreToolUse hook) refused a tool call; kept for the ledger, the run goes on */
  | { type: 'tool.denied'; tool: string; detail: string }

export type RunEvent = EventBody & { seq: number; at: number; run: string; actor: Actor }
export type EventType = EventBody["type"]

export interface Needs { kind: 'plan' | 'question' | 'blocked' | 'verify' | 'review' | 'setup' | 'pr'; ask: string; held?: boolean; deadline?: number }

export interface RunState {
  id: string; ticket: string; title: string; project: string; base: string
  stage: Stage; status: Status; needs?: Needs
  plan?: { summary: string; questions: Question[]; answers?: Record<string, string>; decidedBy?: 'human' | 'deadline' }
  /** verify: red runs in a row; verifyRuns: all runs; review: review runs that found something */
  loops: { verify: number; verifyRuns: number; review: number }
  tokens: number; compactions: number; session?: string
  pr?: { url: string; number: number }
  waitingFor?: string; pausedUntil?: number
  createdAt: number; updatedAt: number
}

export interface Rules { maxRedVerifies: number; maxReviews: number }
export const DEFAULT_RULES: Rules = { maxRedVerifies: 3, maxReviews: 3 }

export class TransitionError extends Error {}

const need = (s: RunState, stage: Stage, e: RunEvent) => {
  if (s.stage !== stage) throw new TransitionError(`${e.type} needs the run in ${stage}, it is in ${s.stage}`)
}
const go = (s: RunState, e: RunEvent, patch: Partial<RunState>): RunState => {
  const out: RunState = { ...s, ...patch, updatedAt: e.at }
  for (const k of ['needs', 'waitingFor', 'pausedUntil'] as const) if (k in patch && patch[k] === undefined) delete out[k]
  return out
}

export function apply(s: RunState | undefined, e: RunEvent, rules: Rules = DEFAULT_RULES): RunState {
  if (e.type === 'run.created') {
    if (s) throw new TransitionError(`run ${e.run} exists already`)
    return { id: e.run, ticket: e.ticket, title: e.title, project: e.project, base: e.base, stage: 'setup', status: 'running',
      loops: { verify: 0, verifyRuns: 0, review: 0 }, tokens: 0, compactions: 0, createdAt: e.at, updatedAt: e.at }
  }
  if (!s) throw new TransitionError(`${e.type} for run ${e.run}, which was never created`)
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
    case 'build.done': need(s, 'build', e); return go(s, e, { stage: 'verify', ...running })
    case 'verify.result': {
      need(s, 'verify', e)
      const verifyRuns = s.loops.verifyRuns + 1
      if (e.ok) return go(s, e, { stage: 'review', loops: { ...s.loops, verify: 0, verifyRuns }, ...running })
      const verify = s.loops.verify + 1
      const loops = { ...s.loops, verify, verifyRuns }
      if (verify >= rules.maxRedVerifies) return go(s, e, { loops, status: 'needs-you', needs: { kind: 'verify', ask: `verify red ${verify} times in a row` } })
      return go(s, e, { stage: 'build', loops, ...running })
    }
    case 'review.result': {
      need(s, 'review', e)
      if (!e.findings) return go(s, e, { stage: 'ship', ...running })
      const loops = { ...s.loops, review: s.loops.review + 1 }
      if (loops.review >= rules.maxReviews) return go(s, e, { loops, status: 'needs-you', needs: { kind: 'review', ask: `${e.findings} findings after ${loops.review} reviews` } })
      return go(s, e, { stage: 'build', loops, ...running })
    }
    case 'pr.opened': need(s, 'ship', e); return go(s, e, { pr: { url: e.url, number: e.number }, status: 'needs-you', needs: { kind: 'pr', ask: `review draft PR #${e.number}` } })
    case 'run.done': return go(s, e, { stage: 'done', status: 'done', needs: undefined, waitingFor: undefined, pausedUntil: undefined })
    case 'agent.asked': return go(s, e, { status: 'needs-you', needs: { kind: 'question', ask: e.question } })
    case 'human.message':
      // a message answers a question or sends a blocked agent on; other states are unchanged
      return s.needs?.kind === 'question' || s.status === 'blocked' ? go(s, e, running) : go(s, e, {})
    case 'run.blocked': return go(s, e, { status: 'blocked', needs: { kind: 'blocked', ask: e.reason } })
    case 'run.waiting': return go(s, e, { status: 'waiting', waitingFor: e.resource })
    case 'run.paused': return go(s, e, { status: 'paused', pausedUntil: e.until })
    case 'run.resumed': return go(s, e, { status: 'running', waitingFor: undefined, pausedUntil: undefined })
    case 'session.started': return go(s, e, { session: e.session })
    case 'session.compacted': return go(s, e, { compactions: s.compactions + 1 })
    case 'tokens.used': return go(s, e, { tokens: s.tokens + e.tokens })
    case 'tool.denied': return go(s, e, {})
  }
}

export function fold(events: RunEvent[], rules: Rules = DEFAULT_RULES): RunState {
  const s = events.reduce<RunState | undefined>((acc, e) => apply(acc, e, rules), undefined)
  if (!s) throw new TransitionError('no events')
  return s
}
