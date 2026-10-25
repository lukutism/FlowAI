import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from './agent/stream.ts'
import type { Az } from './azure.ts'
import { forgeFor, type Forge, type Gh } from './forge.ts'
import type { JiraDeps } from './jira.ts'
import { trackerFor, type Tracker } from './tracker.ts'
import type { Project, Repo } from './config.ts'
import { startDevice, stopDevice, type DeviceState } from './device.ts'
import { startDevServer, stopDevServer, type DevServerState } from './devserver.ts'
import { createWorktree, shipChange } from './git.ts'
import { fill, sh, tail } from './sh.ts'
import { commitMessage, parsePlan, prSummary } from './plan.ts'
import { buildPrompt, contextPrompt, fixPrompt, planPrompt, planRetryPrompt, type Brief } from './prompts.ts'
import { changeText, parseFindings, reviewFixPrompt, reviewPrompt, type Finding } from './review.ts'
import type { RunState } from './run.ts'
import type { Resources } from './resources.ts'
import { Runner, type RunAgent } from './runner.ts'
import { writeRunSettings } from './settings.ts'
import type { EventStore } from './store.ts'
import type { Windows } from './usage.ts'
import { changedFiles, verify } from './verify.ts'

/** a repo of a run: its worktree and the base it started from */
interface RunRepo { key: string; worktree: string; base: string }

/** what a run needs beyond its events: kept as run.json in the run folder */
interface Meta extends Brief { id: number | string; kind: 'bug' | 'feature'; repos: RunRepo[]; platform?: 'android' | 'ios'; web?: string; model?: string }

/** a project's git in a worktree (its env), for flow's own local steps */
const gitIn = (cwd: string, env?: Record<string, string | undefined>) => (...a: string[]) => {
  const x = Bun.spawnSync(['git', ...a], { cwd, env: env ?? process.env })
  return { code: x.exitCode, out: new TextDecoder().decode(x.stdout).trim(), err: new TextDecoder().decode(x.stderr).trim() }
}

export interface PipelineDeps {
  store: EventStore
  project: Project
  az: Az
  /** flow's own data: the event log and one folder per run */
  dataDir: string
  makeAgent: (o: { cwd: string; settings: string; resume?: string; model?: string }) => RunAgent
  /** a fresh, read-only reviewer session per review; without it the review is skipped */
  makeReviewer?: (o: { cwd: string; settings: string }) => RunAgent
  gitEnv?: Record<string, string | undefined>
  now?: () => number
  /** sees each agent event as it arrives (live output); own: the run's agent, not the reviewer */
  tap?: (run: string, e: AgentEvent, own: boolean) => void
  /** each prompt as it is sent to an agent */
  onPrompt?: (run: string, text: string, own: boolean, from: 'flow' | 'you') => void
  /** the plan windows changed (after they are saved) */
  onWindows?: (w: Windows) => void
  /** where tickets come from and PRs go; by default from the project (az, gh, the Jira token in the keychain) */
  tracker?: Tracker
  forge?: Forge
  gh?: Gh
  jira?: JiraDeps
  /** machine-wide slots shared with other runs (the service's): agent turns, builds */
  resources?: Resources
  /** how long a run's device may take to boot (default 3 minutes) */
  deviceReadyTimeoutMs?: number
  /** how long a run's dev server may take to listen (default 5 minutes) */
  devServerReadyTimeoutMs?: number
}

/**
 * A ticket from intake to draft PRs: a worktree per repo, plan turn, the plan gate, build, verify against the base
 * (new findings go back to the agent), an independent review, then a stop for the human to ship. Each step runs
 * until the run needs the human, then returns; the next command (approve, message, ship) carries on from the log.
 */
export class Pipeline {
  readonly runner: Runner
  private agents = new Map<string, RunAgent>()
  /** the device slot each run with a device holds */
  private deviceSlots = new Map<string, () => void>()
  private tracker: Tracker
  private forge: Forge

  constructor(private d: PipelineDeps) {
    this.tracker = d.tracker ?? trackerFor(d.project, { az: d.az, ...d.jira })
    this.forge = d.forge ?? forgeFor(d.project, { az: d.az, gh: d.gh })
    const usage = join(d.dataDir, 'usage.json')
    this.runner = new Runner({
      store: d.store, maxParallel: d.project.agent.maxParallel, limits: d.project.usage, agentFor: run => this.agentFor(run), now: d.now, tap: d.tap, onPrompt: d.onPrompt,
      ...(d.resources ? { agentSlot: (run: string) => d.resources!.acquire(run, 'agents') } : {}),
      windows: existsSync(usage) ? JSON.parse(readFileSync(usage, 'utf8')) : undefined,
      onWindows: w => { mkdirSync(d.dataDir, { recursive: true }); writeFileSync(usage, JSON.stringify(w) + '\n'); d.onWindows?.(w) },
    })
  }

  runDir = (run: string) => join(this.d.dataDir, 'runs', run)
  state = (run: string): RunState | undefined => this.d.store.state(run)
  private planFile = (run: string) => join(this.runDir(run), 'plan.md')
  private prFile = (run: string) => join(this.runDir(run), 'pr.md')
  private repoConfig = (key: string): Repo => this.d.project.repos.find(r => r.key === key)!
  private now = () => (this.d.now ?? Date.now)()
  private must = (run: string) => this.d.store.state(run)!

  /** a heavy step (an install, verify) holds a shared build slot while it runs */
  private async building<T>(run: string, fn: () => Promise<T>): Promise<T> {
    const free = this.d.resources ? await this.d.resources.acquire(run, 'builds') : () => {}
    try { return await fn() } finally { free() }
  }

  /** run.json; one written before runs had several repos (repo + worktree) reads as a single-repo run */
  private meta(run: string): Meta {
    const m = JSON.parse(readFileSync(join(this.runDir(run), 'run.json'), 'utf8')) as Meta & { repo?: string }
    if (!m.repos) m.repos = [{ key: m.repo!, worktree: m.worktree, base: m.base }]
    const s = this.d.store.state(run)
    return { ...m, ...(s?.device ? { device: s.device } : {}), ...(s?.devServer ? { devServer: s.devServer } : {}) }
  }

  /** the agent's folder: the worktree with one repo, the run's root with several */
  private static layout(root: string, repos: RunRepo[]) { return repos.length === 1 ? repos[0]!.worktree : root }

  /** kind: overrides the work item type (a Task may be a fix); repos: else the project's defaults; base: the first repo's */
  /** the run a ticket gets ("fso-204598", "spk-SGL-692"); throws for something that isn't one of the project's tickets */
  runId(ticket: number | string): string {
    const parsed = this.tracker.parseKey(String(ticket))
    const p = this.d.project
    if (!parsed) throw new Error(`${ticket} is not a ticket of project ${p.key} (${p.tracker.kind === 'jira' ? `${p.tracker.key}-<number>` : 'a work item number'})`)
    return `${p.key}-${parsed.id}`
  }

  /** patch: "<customer>/<app>", the customer patch the change goes on (in the run's repo that has patch commands) */
  /** the new-run form's look at a ticket before a run exists */
  async lookup(ticket: number | string) {
    const run = this.runId(ticket)
    const t = await this.tracker.read(this.tracker.parseKey(String(ticket))!.id)
    return { run, exists: !!this.d.store.state(run), key: t.key, title: t.title, kind: t.kind, type: t.type ?? '', url: t.url, board: t.board ?? '', customer: t.customer ?? '', tags: t.tags ?? [], comments: t.comments ?? 0, area: t.area ?? '' }
  }

  /** a repo's bases to start from: its default, then the branches its release patterns match, newest version first */
  bases(repo: string): string[] {
    const c = this.repoConfig(repo)
    const refs = c.releaseBases.length ? new TextDecoder().decode(Bun.spawnSync(['git', 'for-each-ref', '--format=%(refname:short)', ...c.releaseBases.map(p => `refs/remotes/${p}`)], { cwd: c.path }).stdout).split('\n').filter(Boolean) : []
    const ver = (r: string) => (/(\d+)\.(\d+)\.(\d+)/.exec(r) ?? []).slice(1).map(Number)
    const newer = (a: string, b: string) => { const [x, y] = [ver(a), ver(b)]; for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0); return a.localeCompare(b) }
    return [c.defaultBase, ...refs.filter(r => r !== c.defaultBase).sort(newer)]
  }

  private patchRepo() { return this.d.project.repos.find(r => r.patches) }

  /** the customer/app pairs the project has patches for */
  async patchChoices(): Promise<string[]> {
    const r = this.patchRepo()
    if (!r?.patches?.choices) return []
    const res = await sh(r.patches.choices, r.path, this.d.gitEnv)
    return res.code === 0 ? res.out.split('\n').map(x => x.trim()).filter(x => /^[\w.-]+\/[\w.-]+$/.test(x)) : []
  }

  /** whether customer/app has a patch for the base, in the project's words */
  async checkPatch(patch: string, base: string): Promise<{ ok: boolean; text: string }> {
    const r = this.patchRepo()
    const [customer, app] = patch.split('/')
    if (!r?.patches?.check || !customer || !app) return { ok: true, text: '' }
    const res = await sh(fill(r.patches.check, { customer, app, base }), r.path, this.d.gitEnv)
    return { ok: res.code === 0, text: tail(res.out || res.err, 1) }
  }

  async start(ticket: number | string, o: { base?: string; bases?: Record<string, string>; kind?: 'bug' | 'feature'; repos?: string[]; device?: 'android' | 'ios'; patch?: string; devServer?: boolean; model?: string } = {}): Promise<string> {
    const p = this.d.project
    const run = this.runId(ticket)
    if (o.device && !p.devices?.[o.device]) throw new Error(`project ${p.key} has no devices configured for ${o.device} (devices.${o.device} in its config)`)
    const id = this.tracker.parseKey(String(ticket))!.id
    if (this.d.store.state(run)) throw new Error(`run ${run} exists already: flow status ${run}`)
    const keys = o.repos?.length ? o.repos : p.repos.some(r => r.default) ? p.repos.filter(r => r.default).map(r => r.key) : [p.repos[0]!.key]
    const unknown = keys.filter(k => !p.repos.some(r => r.key === k))
    if (unknown.length) throw new Error(`no repo ${unknown.join(', ')} in project ${p.key} (it has ${p.repos.map(r => r.key).join(', ')})`)
    const web = o.devServer ? keys.find(k => this.repoConfig(k).devServer) : undefined
    if (o.devServer && !web) throw new Error(`no repo of this run has a dev server (devServer in the repo's config): ${keys.join(', ')}`)
    let patch: Meta['patch']
    if (o.patch) {
      const [customer, app, ...more] = o.patch.split('/')
      if (!customer || !app || more.length) throw new Error(`--patch is <customer>/<app>, not "${o.patch}"`)
      const repo = keys.find(k => this.repoConfig(k).patches)
      if (!repo) throw new Error(`no repo of this run has patch commands (patches in the repo's config): ${keys.join(', ')}`)
      patch = { customer, app, repo }
    }
    const t = await this.tracker.read(id)
    const kind = o.kind ?? t.kind
    const root = join(p.worktrees, String(id))
    const repos = keys.map((k, i) => ({ key: k, worktree: join(root, k), base: o.bases?.[k] ?? (i === 0 ? o.base : undefined) ?? this.repoConfig(k).defaultBase }))
    const branch = p.naming.branch.replaceAll('{type}', kind === 'bug' ? 'fix' : 'feat').replaceAll('{id}', String(id)).replaceAll('{key}', t.key)
    const m: Meta = { id, key: t.key, title: t.title, kind, url: t.url, branch, base: repos[0]!.base, repos, worktree: Pipeline.layout(root, repos), ...(o.device ? { platform: o.device } : {}), ...(patch ? { patch } : {}), ...(web ? { web } : {}), ...(o.model ? { model: o.model } : {}) }
    mkdirSync(this.runDir(run), { recursive: true })
    writeFileSync(join(this.runDir(run), 'run.json'), JSON.stringify(m, null, 2) + '\n')
    writeFileSync(join(this.runDir(run), 'ticket.md'), `# ${t.key} ${t.title}\n${t.url}\n\n${t.text}\n`)
    this.d.store.append(run, 'human', { type: 'run.created', ticket: t.key, title: t.title, project: p.key, base: m.base })
    if (!(await this.setup(run, m))) return run
    await this.planStep(run, t.text)
    return run
  }

  /** a worktree per repo; false (and setup.failed) when one can't be made */
  private async setup(run: string, m: Meta): Promise<boolean> {
    const notes: string[] = []
    try {
      for (const r of m.repos) {
        const c = this.repoConfig(r.key)
        const w = await this.building(run, () => createWorktree({ repo: c.path, worktree: r.worktree, branch: m.branch, base: r.base, install: c.install }))
        notes.push(...w.notes.map(n => `${r.key}: ${n}`))
      }
    } catch (e) {
      this.d.store.append(run, 'engine', { type: 'setup.failed', reason: (e as Error).message })
      return false
    }
    if (m.patch) {
      try { await this.applyPatch(run, m) } catch (e) {
        this.d.store.append(run, 'engine', { type: 'setup.failed', reason: `patch: ${(e as Error).message}` })
        return false
      }
    }
    if (m.platform) {
      try { await this.bootDevice(run, m.platform, m.repos[0]!.worktree) } catch (e) {
        this.d.store.append(run, 'engine', { type: 'setup.failed', reason: `device: ${(e as Error).message}` })
        return false
      }
    }
    if (m.web) {
      try { await this.bootDevServer(run, m) } catch (e) {
        await this.releaseDevice(run)
        this.d.store.append(run, 'engine', { type: 'setup.failed', reason: `dev server: ${(e as Error).message}` })
        return false
      }
    }
    if (notes.length) writeFileSync(join(this.runDir(run), 'setup-notes.txt'), notes.join('\n') + '\n')
    this.d.store.append(run, 'engine', { type: 'setup.done' })
    return true
  }

  /**
   * The customer's patch, staged by the project's apply command, then committed by flow in the worktree only (never
   * pushed, commit hooks skipped so nothing reformats the customer's code): verify, review and the agent then see
   * only the fix on top of it.
   */
  private async applyPatch(run: string, m: Meta) {
    const { customer, app, repo } = m.patch!
    const r = m.repos.find(x => x.key === repo)!, c = this.repoConfig(repo)
    const res = await sh(fill(c.patches!.apply, { customer, app, base: r.base, main: c.path }), r.worktree, this.d.gitEnv)
    if (res.code !== 0) throw new Error(tail(res.err || res.out) || `the apply command exited ${res.code}`)
    const git = gitIn(r.worktree, this.d.gitEnv)
    if (git('diff', '--cached', '--quiet').code === 0) throw new Error(`the apply command staged nothing (${tail(res.out, 2) || 'no output'})`)
    const commit = git('commit', '--no-verify', '-q', '-m', `customer patch ${customer}/${app} (local to flow, never pushed)`)
    if (commit.code !== 0) throw new Error(`committing it locally failed: ${commit.err}`)
    this.d.store.append(run, 'engine', { type: 'patch.applied', customer, app, summary: tail(res.out, 1), commit: git('rev-parse', 'HEAD').out })
  }

  /**
   * The project's write-back on the whole change (the patch and the fix, new files included): the patch commit is
   * undone for the duration (HEAD back on the base, the patch staged), then the worktree is put back exactly.
   */
  private async writeBack(run: string, m: Meta, dryRun: boolean): Promise<string> {
    const { customer, app, repo } = m.patch!, s = this.must(run)
    const r = m.repos.find(x => x.key === repo)!, c = this.repoConfig(repo)
    const git = gitIn(r.worktree, this.d.gitEnv)
    const commit = s.patch!.commit
    if (git('rev-parse', 'HEAD').out !== commit) throw new Error(`${repo}: HEAD is no longer the patch commit ${commit.slice(0, 8)}; put it back before the write-back`)
    const added = git('ls-files', '--others', '--exclude-standard').out.split('\n').filter(Boolean)
    git('reset', '--soft', '-q', `${commit}~1`)
    try {
      if (added.length) git('add', '-N', '--', ...added) // new files belong in the patch too
      const res = await sh(fill(c.patches!.writeBack, { customer, app, base: r.base, dryRun: dryRun ? '--dry-run' : '' }), r.worktree, this.d.gitEnv)
      const out = (res.out + res.err).trim()
      if (res.code !== 0) throw new Error(`the write-back${dryRun ? ' dry run' : ''} failed (exit ${res.code}):\n${tail(out)}`)
      return `${out}${added.length ? `\nnew files included: ${added.join(', ')}` : ''}\n`
    } finally {
      if (added.length) git('reset', '-q', '--', ...added)
      git('reset', '--soft', '-q', commit)
    }
  }

  /** the run's own device: a device slot, free ports (not another run's), boot, Metro, install; the slot is freed on failure */
  private async bootDevice(run: string, platform: 'android' | 'ios', worktree: string) {
    const free = this.d.resources ? await this.d.resources.acquire(run, 'devices') : () => {}
    try {
      const taken = new Set<number>()
      const runs = join(this.d.dataDir, 'runs')
      for (const other of existsSync(runs) ? readdirSync(runs) : []) {
        const f = join(runs, other, 'device.json')
        if (other !== run && existsSync(f)) { const d = JSON.parse(readFileSync(f, 'utf8')) as DeviceState; taken.add(d.consolePort).add(d.consolePort + 1).add(d.metroPort) }
      }
      const d = await this.building(run, () => startDevice({ spec: this.d.project.devices!, platform, run, runDir: this.runDir(run), worktree, taken, readyTimeoutMs: this.d.deviceReadyTimeoutMs }))
      this.deviceSlots.set(run, free)
      this.d.store.append(run, 'engine', { type: 'device.ready', platform, id: d.id, metroPort: d.metroPort })
    } catch (e) { free(); throw e }
  }

  /** the run's own dev server, in a build slot while it starts (a first build is heavy), on a port no other run holds */
  private async bootDevServer(run: string, m: Meta) {
    const r = m.repos.find(x => x.key === m.web)!, c = this.repoConfig(m.web!).devServer!
    const taken = new Set<number>()
    const runs = join(this.d.dataDir, 'runs')
    for (const other of existsSync(runs) ? readdirSync(runs) : []) {
      const f = join(runs, other, 'devserver.json')
      if (other !== run && existsSync(f)) taken.add((JSON.parse(readFileSync(f, 'utf8')) as DevServerState).port)
    }
    const d = await this.building(run, () => startDevServer({ run, repo: r.key, cmd: c.cmd, portStart: c.portStart, url: c.url, runDir: this.runDir(run), worktree: r.worktree, taken, readyTimeoutMs: this.d.devServerReadyTimeoutMs }))
    this.d.store.append(run, 'engine', { type: 'devserver.ready', repo: d.repo, port: d.port, url: d.url })
  }

  /** stop the run's device and dev server and free the device slot (at ship, or by hand); nothing to do when it has none */
  async releaseDevice(run: string) {
    const web = join(this.runDir(run), 'devserver.json')
    if (existsSync(web)) {
      await stopDevServer(JSON.parse(readFileSync(web, 'utf8')) as DevServerState, this.runDir(run))
      if (this.d.store.state(run)?.devServer) this.d.store.append(run, 'engine', { type: 'devserver.stopped' })
    }
    const f = join(this.runDir(run), 'device.json')
    if (!existsSync(f) || !this.d.project.devices) return
    await stopDevice(JSON.parse(readFileSync(f, 'utf8')) as DeviceState, this.d.project.devices, this.runDir(run))
    this.deviceSlots.get(run)?.()
    this.deviceSlots.delete(run)
    this.d.store.append(run, 'engine', { type: 'device.released' })
  }

  async approve(run: string, answers: Record<string, string> = {}) {
    const s = this.must(run)
    if (s.needs?.kind !== 'plan' || !s.plan) throw new Error(`${run}: no plan is waiting for a decision (${s.status})`)
    const unknown = Object.keys(answers).filter(k => !s.plan!.questions.some(q => q.id === k))
    if (unknown.length) throw new Error(`${run}: the plan has no question ${unknown.join(', ')}`)
    const all = Object.fromEntries(s.plan.questions.map(q => [q.id, answers[q.id] ?? q.default]))
    this.d.store.append(run, 'human', { type: 'plan.decided', by: 'human', answers: all })
    await this.buildStep(run)
  }

  /** the plan's deadline passed with no answer: the engine takes the defaults (never for a held question) */
  async decideByDeadline(run: string) {
    const s = this.must(run)
    if (s.needs?.kind !== 'plan' || !s.plan) throw new Error(`${run}: no plan is waiting for a decision`)
    if (s.needs.held) throw new Error(`${run}: the plan has a held question; only you can answer it`)
    this.d.store.append(run, 'engine', { type: 'plan.decided', by: 'deadline', answers: Object.fromEntries(s.plan.questions.map(q => [q.id, q.default])) })
    await this.buildStep(run)
  }

  /** a message from the human: goes to the run's session; afterwards the run carries on from where it is */
  async message(run: string, text: string) {
    this.d.store.append(run, 'human', { type: 'human.message', text })
    const r = await this.say(run, text, 'you')
    if (!r.ok) return
    const s = this.must(run)
    if (s.stage === 'plan' && !s.plan) { const p = this.readPlan(run); if ('plan' in p) await this.submitPlan(run, p.plan) }
    else if (s.stage === 'build' && s.status === 'running') { this.d.store.append(run, 'agent', { type: 'build.done' }); await this.verifyLoop(run) }
  }

  /** a commit, a push and a draft PR for each repo the run changed */
  async ship(run: string): Promise<{ number: number; url: string }[]> {
    const s = this.must(run)
    if (s.needs?.kind !== 'ship' && !(s.needs?.kind === 'patch' && s.patch)) throw new Error(`${run} is not ready to ship (${s.stage}, ${s.status}${s.needs ? `: ${s.needs.ask}` : ''})`)
    const m = this.meta(run), n = this.d.project.naming
    if (m.patch) {
      // a customer patch run ends in the patch written back, not a PR: a dry run first, then (ship again) for real
      const others = m.repos.filter(r => r.key !== m.patch!.repo && changedFiles(r.worktree).length).map(r => r.key)
      if (others.length) throw new Error(`${run}: a patch run ships only its patch, but ${others.join(', ')} changed too`)
      const first = s.needs.kind === 'ship'
      const report = await this.writeBack(run, m, first)
      writeFileSync(join(this.runDir(run), 'patch-report.txt'), report)
      this.d.store.append(run, 'human', first ? { type: 'patch.checked', report } : { type: 'patch.written', report })
      if (!first) await this.releaseDevice(run)
      return []
    }
    const changed = m.repos.map(r => ({ r, files: changedFiles(r.worktree) })).filter(x => x.files.length)
    if (!changed.length) throw new Error(`${run}: nothing to ship, no repo has changes`)
    const pr = existsSync(this.prFile(run)) ? readFileSync(this.prFile(run), 'utf8') : ''
    const summary = prSummary(pr, m.title)
    const body = n.prBody === 'ticket-link' ? m.url : pr.replace(/^#\s+.+\n?/m, '').trim() || `${m.key} ${m.title}\n${m.url}`
    const title = n.prTitle === 'key' ? m.key : `${m.key} ${summary}`
    const message = (files: string[], repo: string) => (n.commit === 'key-summary' ? `${m.key} ${summary}`.slice(0, 100) : commitMessage({ id: m.id, title: m.title, kind: m.kind }, files, repo))
    const created: { number: number; url: string }[] = []
    for (const { r, files } of changed) {
      await shipChange({ worktree: r.worktree, branch: m.branch, message: message(files, r.key), env: this.d.gitEnv })
      const origin = Bun.spawnSync(['git', 'remote', 'get-url', 'origin'], { cwd: r.worktree })
      const repository = new TextDecoder().decode(origin.stdout).trim().replace(/\.git$/, '').split(/[/:]/).pop()!
      const c = this.forge.draftPr({ repository, head: m.branch, base: r.base.replace(/^origin\//, ''), title, body, ...(typeof m.id === 'number' ? { workItem: m.id } : {}) })
      this.d.store.append(run, 'human', { type: 'pr.opened', url: c.url, number: c.number, ...(m.repos.length > 1 ? { repo: r.key } : {}) })
      created.push(c)
    }
    await this.releaseDevice(run)
    return created
  }

  /**
   * The same fix onto another line (release fix → develop): a new run on <to> with each repo's shipped commits
   * applied uncommitted, then verify and review as usual and a stop to ship. A conflict blocks it, naming the files.
   */
  async port(source: string, to = 'develop'): Promise<string> {
    const src = this.d.store.state(source)
    if (!src?.pr) throw new Error(`${source} is not shipped yet: port a run that has its draft PR`)
    const m = this.meta(source), p = this.d.project, short = to.split('/').pop()!
    const run = `${source}-${short}`
    if (this.d.store.state(run)) throw new Error(`run ${run} exists already`)
    const root = join(p.worktrees, `${m.id}-${short}`)
    const repos = m.repos.map(r => ({ key: r.key, worktree: join(root, r.key), base: `origin/${to}` }))
    const { device: _, devServer: __, ...src0 } = m // the source's device and dev server are its own; the port starts its own
    const pm: Meta = { ...src0, base: `origin/${to}`, branch: `${m.branch}-${short}`, repos, worktree: Pipeline.layout(root, repos) }
    mkdirSync(this.runDir(run), { recursive: true })
    writeFileSync(join(this.runDir(run), 'run.json'), JSON.stringify(pm, null, 2) + '\n')
    for (const f of ['ticket.md', 'plan.md']) if (existsSync(join(this.runDir(source), f))) writeFileSync(join(this.runDir(run), f), readFileSync(join(this.runDir(source), f)))
    const from = m.base.replace(/^origin\//, '')
    const pr = existsSync(this.prFile(source)) ? readFileSync(this.prFile(source), 'utf8') : `# ${m.title}\n`
    const prs = (src.prs ?? [src.pr]).map(x => `#${x.number}`).join(', ')
    writeFileSync(this.prFile(run), pr.replace(/^(#\s+.+\n?)/m, `$1\nPort of ${src.ticket} PR ${prs} (${from}) to ${to}.\n`))
    this.d.store.append(run, 'human', { type: 'run.created', ticket: m.key, title: m.title, project: p.key, base: pm.base })
    if (!(await this.setup(run, pm))) return run
    this.d.store.append(run, 'engine', { type: 'plan.submitted', summary: `Port of ${src.ticket} PR ${prs} (${from}) to ${to}`, questions: [] })
    const conflicts: string[] = []
    for (const [i, r] of repos.entries()) {
      const git = (...a: string[]) => { const x = Bun.spawnSync(['git', ...a], { cwd: r.worktree, env: this.d.gitEnv ?? process.env }); return { code: x.exitCode, out: new TextDecoder().decode(x.stdout).trim() } }
      const commits = git('log', '--reverse', '--format=%H', `${m.repos[i]!.base}..${m.branch}`).out.split('\n').filter(Boolean)
      if (!commits.length) continue
      if (git('cherry-pick', '--no-commit', ...commits).code !== 0) {
        const files = git('diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean)
        conflicts.push(...(files.length ? files : ['(unknown files)']).map(f => (repos.length > 1 ? `${r.key}/${f}` : f)))
        continue
      }
      git('reset', '--quiet') // the change stays in the working tree, as an agent's would
    }
    if (conflicts.length) {
      this.d.store.append(run, 'engine', { type: 'run.blocked', reason: `the port conflicts in ${conflicts.join(', ')}: message the agent to resolve them, or resolve them by hand in ${pm.worktree}` })
      return run
    }
    this.d.store.append(run, 'engine', { type: 'build.done' })
    await this.verifyLoop(run)
    return run
  }

  /** a message to the run's agent; an agent with no session yet (a port's) gets the run's context first */
  private say(run: string, text: string, from: 'flow' | 'you' = 'flow') {
    const s = this.must(run)
    return this.runner.turn(run, s.session ? text : contextPrompt(this.meta(run), this.planFile(run), this.prFile(run), text), from)
  }

  private agentFor(run: string): RunAgent {
    const cached = this.agents.get(run)
    if (cached) return cached
    const m = this.meta(run)
    const others = m.repos.map(r => r.worktree).filter(w => w !== m.worktree)
    const settings = writeRunSettings({ dir: this.runDir(run), worktree: m.worktree, allow: [...others, this.runDir(run)], sandbox: this.d.project.sandbox })
    const agent = this.d.makeAgent({ cwd: m.worktree, settings, resume: this.d.store.state(run)?.session, ...(m.model ? { model: m.model } : {}) })
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
    if (this.must(run).stage === 'build') await this.buildStep(run)
  }

  private async buildStep(run: string) {
    const s = this.must(run)
    const answers = (s.plan?.questions ?? []).map(q => ({ id: q.id, text: q.text, answer: s.plan?.answers?.[q.id] ?? q.default }))
    const r = await this.runner.turn(run, buildPrompt(this.meta(run), answers, this.prFile(run)))
    if (!r.ok) return
    this.d.store.append(run, 'agent', { type: 'build.done' })
    await this.verifyLoop(run)
  }

  /** verify every repo; with several repos each finding names its repo */
  private async verifyAll(run: string, m: Meta): Promise<{ ok: boolean; findings: string[] }> {
    let ok = true
    const findings: string[] = []
    for (const r of m.repos) {
      const res = await this.building(run, () => verify(r.worktree, this.repoConfig(r.key).verify))
      ok &&= res.ok
      findings.push(...res.steps.flatMap(s => s.newFindings).map(f => (m.repos.length > 1 ? `${r.key}: ${f}` : f)))
    }
    return { ok, findings }
  }

  private async verifyLoop(run: string) {
    const m = this.meta(run)
    for (;;) {
      let res
      try { res = await this.verifyAll(run, m) }
      catch (e) { this.d.store.append(run, 'engine', { type: 'run.blocked', reason: `verify could not run: ${(e as Error).message}` }); return }
      this.d.store.append(run, 'engine', { type: 'verify.result', ok: res.ok, newFindings: res.findings })
      let s = this.must(run)
      let prompt = fixPrompt(res.findings)
      if (s.stage === 'review') {
        const found = await this.reviewStep(run)
        s = this.must(run)
        if (s.stage !== 'build' || !found) return // clean, skipped, or stopped for the human (review cap)
        prompt = reviewFixPrompt(found)
      }
      if (s.stage !== 'build') return // stopped for the human (red too often)
      const r = await this.say(run, prompt)
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
    const others = m.repos.map(r => r.worktree).filter(w => w !== m.worktree)
    const settings = writeRunSettings({ dir: join(this.runDir(run), 'reviewer'), worktree: m.worktree, allow: others, sandbox: this.d.project.sandbox })
    const reviewer = this.d.makeReviewer({ cwd: m.worktree, settings })
    try {
      const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
      const change = m.repos.length > 1 ? m.repos.map(r => `### ${r.key} (${r.worktree})\n${changeText(r.worktree) || '(no change)'}`).join('\n\n') : changeText(m.repos[0]!.worktree)
      const prompt = reviewPrompt({ key: m.key, title: m.title, ticket: read(join(this.runDir(run), 'ticket.md')), plan: read(this.planFile(run)), change })
      let r = await this.runner.turnWith(run, reviewer, prompt, { ownSession: false })
      if (!r.ok) return null
      let parsed: ReturnType<typeof parseFindings>
      try { parsed = parseFindings(r.text) } catch (first) {
        r = await this.runner.turnWith(run, reviewer, 'Answer again with the short note and exactly one ```json block holding the array of findings (an empty array if none).', { ownSession: false })
        if (!r.ok) return null
        try { parsed = parseFindings(r.text) } catch (e) { return skip(`review unreadable: ${(e as Error).message} (first answer: ${(first as Error).message})`) }
      }
      const n = this.must(run).loops.review + 1
      writeFileSync(join(this.runDir(run), 'review.json'), JSON.stringify({ review: n, at: this.now(), findings: parsed.findings, dropped: parsed.dropped, below: parsed.below, note: parsed.note }, null, 2) + '\n')
      this.d.store.append(run, 'engine', { type: 'review.result', findings: parsed.findings.length })
      return parsed.findings.length ? parsed.findings : null
    } finally { await reviewer.close?.() }
  }
}
