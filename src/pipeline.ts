import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from './agent/stream.ts'
import { azureDraftPr, azureTicket, type Az } from './azure.ts'
import type { Project } from './config.ts'
import { createWorktree, shipChange } from './git.ts'
import { commitMessage, parsePlan, prSummary } from './plan.ts'
import { buildPrompt, fixPrompt, planPrompt, planRetryPrompt, type Brief } from './prompts.ts'
import { Runner, type RunAgent } from './runner.ts'
import { writeRunSettings } from './settings.ts'
import type { EventStore } from './store.ts'
import type { Windows } from './usage.ts'
import { changedFiles, verify } from './verify.ts'
import { changeText, parseFindings, reviewFixPrompt, reviewPrompt, type Finding } from './review.ts'

/** what a run needs beyond its events: kept as run.json in the run folder */
interface Meta extends Brief { id: number; kind: 'bug' | 'feature'; repo: string }

export interface PipelineDeps {
  store: EventStore
  project: Project
  az: Az
  /** flow's own data: the event log and one folder per run */
  dataDir: string
  makeAgent: (o: { cwd: string; settings: string; resume?: string }) => RunAgent
  /** a fresh, read-only reviewer session per review; without it the review is skipped */
  makeReviewer?: (o: { cwd: string; settings: string }) => RunAgent
  gitEnv?: Record<string, string | undefined>
  now?: () => number
  /** sees each agent event as it arrives (live output) */
  tap?: (run: string, e: AgentEvent) => void
  /** the plan windows changed (after they are saved) */
  onWindows?: (w: Windows) => void
}

/**
 * A ticket from intake to a draft PR: worktree, plan turn, the plan gate, build, verify against the base (new
 * findings go back to the agent), then a stop for the human to ship. Each step runs until the run needs the
 * human, then returns; the next command (approve, message, ship) carries on from the log.
 */
export class Pipeline {
  readonly runner: Runner
  private agents = new Map<string, RunAgent>()

  constructor(private d: PipelineDeps) {
    const usage = join(d.dataDir, 'usage.json')
    this.runner = new Runner({
      store: d.store, maxParallel: d.project.agent.maxParallel, limits: d.project.usage, agentFor: run => this.agentFor(run), now: d.now, tap: d.tap,
      windows: existsSync(usage) ? JSON.parse(readFileSync(usage, 'utf8')) : undefined,
      onWindows: w => { mkdirSync(d.dataDir, { recursive: true }); writeFileSync(usage, JSON.stringify(w) + '\n'); d.onWindows?.(w) },
    })
  }

  runDir = (run: string) => join(this.d.dataDir, 'runs', run)
  private meta = (run: string): Meta => JSON.parse(readFileSync(join(this.runDir(run), 'run.json'), 'utf8'))
  private planFile = (run: string) => join(this.runDir(run), 'plan.md')
  private prFile = (run: string) => join(this.runDir(run), 'pr.md')
  private repo = (m: Meta) => this.d.project.repos.find(r => r.key === m.repo)!
  private state = (run: string) => this.d.store.state(run)!
  private now = () => (this.d.now ?? Date.now)()

  /** kind: overrides the work item type (a Task may be a fix) */
  async start(id: number, o: { base?: string; kind?: 'bug' | 'feature' } = {}): Promise<string> {
    const p = this.d.project
    if (p.tracker.kind !== 'azure') throw new Error(`${p.tracker.kind} tickets are not supported yet`)
    const run = `${p.key}-${id}`
    if (this.d.store.state(run)) throw new Error(`run ${run} exists already: flow status ${run}`)
    const t = azureTicket(this.d.az, p.tracker, id)
    const repo = p.repos[0]!
    const kind = o.kind ?? t.kind
    const m: Meta = { id, key: t.key, title: t.title, kind, url: t.url, repo: repo.key, base: o.base ?? repo.defaultBase,
      branch: `${kind === 'bug' ? 'fix' : 'feat'}/${id}`, worktree: join(p.worktrees, String(id), repo.key) }
    mkdirSync(this.runDir(run), { recursive: true })
    writeFileSync(join(this.runDir(run), 'run.json'), JSON.stringify(m, null, 2) + '\n')
    writeFileSync(join(this.runDir(run), 'ticket.md'), `# ${t.key} ${t.title}\n${t.url}\n\n${t.text}\n`)
    this.d.store.append(run, 'human', { type: 'run.created', ticket: t.key, title: t.title, project: p.key, base: m.base })
    try {
      const w = await createWorktree({ repo: repo.path, worktree: m.worktree, branch: m.branch, base: m.base, install: repo.install })
      if (w.notes.length) writeFileSync(join(this.runDir(run), 'setup-notes.txt'), w.notes.join('\n') + '\n')
      this.d.store.append(run, 'engine', { type: 'setup.done' })
    } catch (e) {
      this.d.store.append(run, 'engine', { type: 'setup.failed', reason: (e as Error).message })
      return run
    }
    await this.planStep(run, t.text)
    return run
  }

  async approve(run: string, answers: Record<string, string> = {}) {
    const s = this.state(run)
    if (s.needs?.kind !== 'plan' || !s.plan) throw new Error(`${run}: no plan is waiting for a decision (${s.status})`)
    const unknown = Object.keys(answers).filter(k => !s.plan!.questions.some(q => q.id === k))
    if (unknown.length) throw new Error(`${run}: the plan has no question ${unknown.join(', ')}`)
    const all = Object.fromEntries(s.plan.questions.map(q => [q.id, answers[q.id] ?? q.default]))
    this.d.store.append(run, 'human', { type: 'plan.decided', by: 'human', answers: all })
    await this.buildStep(run)
  }

  /** the plan's deadline passed with no answer: the engine takes the defaults (never for a held question) */
  async decideByDeadline(run: string) {
    const s = this.state(run)
    if (s.needs?.kind !== 'plan' || !s.plan) throw new Error(`${run}: no plan is waiting for a decision`)
    if (s.needs.held) throw new Error(`${run}: the plan has a held question; only you can answer it`)
    this.d.store.append(run, 'engine', { type: 'plan.decided', by: 'deadline', answers: Object.fromEntries(s.plan.questions.map(q => [q.id, q.default])) })
    await this.buildStep(run)
  }

  /** a message from the human: goes to the run's session; afterwards the run carries on from where it is */
  async message(run: string, text: string) {
    this.d.store.append(run, 'human', { type: 'human.message', text })
    const r = await this.runner.turn(run, text)
    if (!r.ok) return
    const s = this.state(run)
    if (s.stage === 'plan' && !s.plan) { const p = this.readPlan(run); if ('plan' in p) await this.submitPlan(run, p.plan) }
    else if (s.stage === 'build' && s.status === 'running') { this.d.store.append(run, 'agent', { type: 'build.done' }); await this.verifyLoop(run) }
  }

  async ship(run: string): Promise<{ number: number; url: string }> {
    const s = this.state(run)
    if (s.needs?.kind !== 'ship') throw new Error(`${run} is not ready to ship (${s.stage}, ${s.status}${s.needs ? `: ${s.needs.ask}` : ''})`)
    const m = this.meta(run), p = this.d.project
    const pr = existsSync(this.prFile(run)) ? readFileSync(this.prFile(run), 'utf8') : ''
    const summary = prSummary(pr, m.title)
    const body = pr.replace(/^#\s+.+\n?/m, '').trim() || `${m.key} ${m.title}\n${m.url}`
    const message = commitMessage({ id: m.id, title: m.title, kind: m.kind }, changedFiles(m.worktree), m.repo)
    await shipChange({ worktree: m.worktree, branch: m.branch, message, env: this.d.gitEnv })
    if (p.forge.kind !== 'azure') throw new Error(`${p.forge.kind} pull requests are not supported yet`)
    const origin = Bun.spawnSync(['git', 'remote', 'get-url', 'origin'], { cwd: m.worktree })
    const repository = new TextDecoder().decode(origin.stdout).trim().replace(/\.git$/, '').split('/').pop()!
    const created = azureDraftPr(this.d.az, p.forge, repository, { head: m.branch, base: m.base.replace(/^origin\//, ''), title: `${m.key} ${summary}`, body, workItem: m.id })
    this.d.store.append(run, 'human', { type: 'pr.opened', url: created.url, number: created.number })
    return created
  }

  /**
   * The same fix onto another line (release fix → develop): a new run on <to> with the shipped commits applied
   * uncommitted, then verify and review as usual and a stop to ship. A conflict blocks the run, naming the files.
   */
  async port(source: string, to = 'develop'): Promise<string> {
    const src = this.d.store.state(source)
    if (!src?.pr) throw new Error(`${source} is not shipped yet: port a run that has its draft PR`)
    const m = this.meta(source), p = this.d.project, short = to.split('/').pop()!
    const run = `${source}-${short}`
    if (this.d.store.state(run)) throw new Error(`run ${run} exists already`)
    const repo = this.repo(m)
    const pm: Meta = { ...m, base: `origin/${to}`, branch: `${m.branch}-${short}`, worktree: join(p.worktrees, `${m.id}-${short}`, m.repo) }
    mkdirSync(this.runDir(run), { recursive: true })
    writeFileSync(join(this.runDir(run), 'run.json'), JSON.stringify(pm, null, 2) + '\n')
    for (const f of ['ticket.md', 'plan.md']) if (existsSync(join(this.runDir(source), f))) writeFileSync(join(this.runDir(run), f), readFileSync(join(this.runDir(source), f)))
    const from = m.base.replace(/^origin\//, '')
    const pr = existsSync(this.prFile(source)) ? readFileSync(this.prFile(source), 'utf8') : `# ${m.title}\n`
    writeFileSync(this.prFile(run), pr.replace(/^(#\s+.+\n?)/m, `$1\nPort of ${src.ticket} PR #${src.pr.number} (${from}) to ${to}.\n`))
    this.d.store.append(run, 'human', { type: 'run.created', ticket: m.key, title: m.title, project: p.key, base: pm.base })
    try {
      await createWorktree({ repo: repo.path, worktree: pm.worktree, branch: pm.branch, base: pm.base, install: repo.install })
      this.d.store.append(run, 'engine', { type: 'setup.done' })
    } catch (e) { this.d.store.append(run, 'engine', { type: 'setup.failed', reason: (e as Error).message }); return run }
    const git = (...a: string[]) => { const r = Bun.spawnSync(['git', ...a], { cwd: pm.worktree, env: this.d.gitEnv ?? process.env }); return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim(), err: new TextDecoder().decode(r.stderr).trim() } }
    const commits = git('log', '--reverse', '--format=%H', `${m.base}..${m.branch}`).out.split('\n').filter(Boolean)
    this.d.store.append(run, 'engine', { type: 'plan.submitted', summary: `Port of ${src.ticket} PR #${src.pr.number} (${from}) to ${to}`, questions: [] })
    const pick = git('cherry-pick', '--no-commit', ...commits)
    if (pick.code !== 0) {
      const files = git('diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean)
      this.d.store.append(run, 'engine', { type: 'run.blocked', reason: `the port conflicts in ${files.join(', ') || '(unknown files)'}: message the agent to resolve them, or resolve them by hand in ${pm.worktree}` })
      return run
    }
    git('reset', '--quiet') // the change stays in the working tree, as an agent's would
    this.d.store.append(run, 'engine', { type: 'build.done' })
    await this.verifyLoop(run)
    return run
  }

  private agentFor(run: string): RunAgent {
    const cached = this.agents.get(run)
    if (cached) return cached
    const m = this.meta(run)
    const settings = writeRunSettings({ dir: this.runDir(run), worktree: m.worktree, allow: [this.runDir(run)] })
    const agent = this.d.makeAgent({ cwd: m.worktree, settings, resume: this.d.store.state(run)?.session })
    this.agents.set(run, agent)
    return agent
  }

  async close() { for (const a of this.agents.values()) await a.close?.() }

  private readPlan(run: string): { plan: ReturnType<typeof parsePlan> } | { problem: string } {
    if (!existsSync(this.planFile(run))) return { problem: 'is missing' }
    try { return { plan: parsePlan(readFileSync(this.planFile(run), 'utf8')) } } catch (e) { return { problem: `can't be read: ${(e as Error).message}` } }
  }

  private async planStep(run: string, ticket: string) {
    const r = await this.runner.turn(run, planPrompt(this.meta(run), ticket, this.planFile(run)))
    if (!r.ok) return
    let p = this.readPlan(run)
    if ('problem' in p) {
      const again = await this.runner.turn(run, planRetryPrompt(this.planFile(run), p.problem))
      if (!again.ok) return
      p = this.readPlan(run)
      if ('problem' in p) { this.d.store.append(run, 'engine', { type: 'run.blocked', reason: `the agent wrote no plan (${this.planFile(run)} ${p.problem}); message it, or write the plan yourself` }); return }
    }
    await this.submitPlan(run, p.plan)
  }

  private async submitPlan(run: string, plan: ReturnType<typeof parsePlan>) {
    const held = plan.questions.some(q => q.held)
    const deadline = plan.questions.length && !held ? this.now() + this.d.project.plan.deadlineMinutes * 60_000 : undefined
    this.d.store.append(run, 'agent', { type: 'plan.submitted', summary: plan.summary, questions: plan.questions, ...(deadline ? { deadline } : {}) })
    if (this.state(run).stage === 'build') await this.buildStep(run)
  }

  private async buildStep(run: string) {
    const s = this.state(run)
    const answers = (s.plan?.questions ?? []).map(q => ({ id: q.id, text: q.text, answer: s.plan?.answers?.[q.id] ?? q.default }))
    const r = await this.runner.turn(run, buildPrompt(this.meta(run), answers, this.prFile(run)))
    if (!r.ok) return
    this.d.store.append(run, 'agent', { type: 'build.done' })
    await this.verifyLoop(run)
  }

  private async verifyLoop(run: string) {
    const m = this.meta(run)
    for (;;) {
      let res
      try { res = await verify(m.worktree, this.repo(m).verify) }
      catch (e) { this.d.store.append(run, 'engine', { type: 'run.blocked', reason: `verify could not run: ${(e as Error).message}` }); return }
      const findings = res.steps.flatMap(s => s.newFindings)
      this.d.store.append(run, 'engine', { type: 'verify.result', ok: res.ok, newFindings: findings })
      let s = this.state(run)
      let prompt = fixPrompt(findings)
      if (s.stage === 'review') {
        const found = await this.reviewStep(run)
        s = this.state(run)
        if (s.stage !== 'build' || !found) return // clean, skipped, or stopped for the human (review cap)
        prompt = reviewFixPrompt(found)
      }
      if (s.stage !== 'build') return // stopped for the human (red too often)
      const r = await this.runner.turn(run, prompt)
      if (!r.ok) return
      this.d.store.append(run, 'agent', { type: 'build.done' })
    }
  }

  /** the independent review; returns its findings when the agent has something to fix */
  private async reviewStep(run: string): Promise<Finding[] | null> {
    const m = this.meta(run)
    const skip = (reason: string) => { this.d.store.append(run, 'engine', { type: 'review.skipped', reason }); return null }
    if (!this.d.project.review.enabled) return skip('review is off for this project')
    if (!this.d.makeReviewer) return skip('no reviewer configured')
    const settings = writeRunSettings({ dir: join(this.runDir(run), 'reviewer'), worktree: m.worktree })
    const reviewer = this.d.makeReviewer({ cwd: m.worktree, settings })
    try {
      const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
      const prompt = reviewPrompt({ key: m.key, title: m.title, ticket: read(join(this.runDir(run), 'ticket.md')), plan: read(this.planFile(run)), change: changeText(m.worktree) })
      let r = await this.runner.turnWith(run, reviewer, prompt, { ownSession: false })
      if (!r.ok) return null
      let parsed: ReturnType<typeof parseFindings>
      try { parsed = parseFindings(r.text) } catch (first) {
        r = await this.runner.turnWith(run, reviewer, 'Answer again with the short note and exactly one ```json block holding the array of findings (an empty array if none).', { ownSession: false })
        if (!r.ok) return null
        try { parsed = parseFindings(r.text) } catch (e) { return skip(`review unreadable: ${(e as Error).message} (first answer: ${(first as Error).message})`) }
      }
      const n = this.state(run).loops.review + 1
      writeFileSync(join(this.runDir(run), 'review.json'), JSON.stringify({ review: n, at: this.now(), findings: parsed.findings, dropped: parsed.dropped }, null, 2) + '\n')
      this.d.store.append(run, 'engine', { type: 'review.result', findings: parsed.findings.length })
      return parsed.findings.length ? parsed.findings : null
    } finally { await reviewer.close?.() }
  }
}
